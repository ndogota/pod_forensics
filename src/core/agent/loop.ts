// The agent loop.
//
// A tool-use loop over a ModelClient with free tool choice, bounded by a max
// step count. The agent sees the nine read-only tools plus a terminal
// submit_diagnosis tool. The loop ends when the model calls submit_diagnosis
// with a valid Diagnosis, or when it runs out of steps.
//
// The loop depends only on the ToolProvider and ModelClient interfaces. It does
// not know whether tool calls resolve from fixtures or a live cluster, nor
// whether the model is real or scripted.

import type { ToolProvider } from "../providers/toolProvider";
import { normalizeArgs } from "../tools/argsHash";
import type { Diagnosis, RunTrace, ToolCall, TraceStep } from "../types";
import { DEFAULT_AGENT_CONFIG, type AgentConfig } from "./config";
import {
  SUBMIT_DIAGNOSIS_TOOL,
  diagnosisSchema,
  formatDiagnosisIssues,
  submitDiagnosisDefinition,
} from "./diagnosisSchema";
import type {
  ModelClient,
  ModelMessage,
  ModelTool,
  ModelToolResult,
} from "./modelClient";
import { SYSTEM_PROMPT, buildInitialUserPrompt } from "./prompts";

// How many times an invalid submit_diagnosis is returned to the model with its
// validation issues so it can correct itself. After this many corrections a
// still-invalid submit fails the run cleanly. This bounds the exchange: the loop
// never retries blindly and never loops unbounded.
const MAX_DIAGNOSIS_CORRECTIONS = 2;

export interface RunAgentOptions {
  scenarioId: string;
  namespace: string;
  provider: ToolProvider;
  client: ModelClient;
  config?: AgentConfig;
}

// The token usage a run had accumulated at the moment it ended. A successful run
// carries this on its RunTrace; a failed run carries it on the AgentRunError, so
// the eval cost summary can price failed runs too instead of understating the
// true cost by ignoring them. Only the fields the pricing table needs.
export interface RunUsage {
  tokensIn: number;
  tokensOut: number;
  cacheReadTokens: number;
}

// Thrown when the agent fails to produce a valid diagnosis within the step
// budget, including after up to MAX_DIAGNOSIS_CORRECTIONS informed correction
// turns on an invalid submit_diagnosis payload. It carries the usage accumulated
// up to the failure, so the eval can account for the tokens a failed run spent.
export class AgentRunError extends Error {
  readonly usage?: RunUsage;
  constructor(message: string, usage?: RunUsage) {
    super(message);
    this.usage = usage;
  }
}

// A distinct failure: the model turn was cut off by max_tokens before it could
// emit the full tool payload, so trailing required fields never arrived. This is
// not a malformed diagnosis the model can be coached to fix; every retry would be
// truncated identically. It extends AgentRunError so the runner records it as a
// failed run and counts it against the completion rate, but the reason is
// unambiguous. The remedy is a larger max_tokens, not a correction turn.
export class TruncatedOutputError extends AgentRunError {}

export async function runAgent(options: RunAgentOptions): Promise<RunTrace> {
  const config = options.config ?? DEFAULT_AGENT_CONFIG;
  const { provider, client, namespace, scenarioId } = options;

  const tools: ModelTool[] = [
    ...provider.listTools(),
    submitDiagnosisDefinition,
  ];

  const messages: ModelMessage[] = [
    { role: "user", content: buildInitialUserPrompt(namespace) },
  ];

  const steps: TraceStep[] = [];
  let totalTokens = 0;
  let totalTokensIn = 0;
  let totalTokensOut = 0;
  let totalLatencyMs = 0;
  let costUsd = 0;
  let invalidSubmitCount = 0;
  // Prompt-cache accounting. cacheReadAfterFirstTurn isolates reads on turns past
  // the first, which is exactly where caching is supposed to pay off: the first
  // turn writes the cache, later turns read the earlier context back from it.
  let totalCacheReadTokens = 0;
  let totalCacheCreationTokens = 0;
  let cacheReadAfterFirstTurn = 0;
  // Track the most recent turn's stop reason so budget exhaustion can tell a
  // genuinely stuck agent from one whose last turn was simply truncated.
  let lastStopReason = "";

  // Snapshot the usage accumulated so far, for attaching to a failure. Closes
  // over the running totals, so it reflects everything spent up to the throw.
  const usageSoFar = (): RunUsage => ({
    tokensIn: totalTokensIn,
    tokensOut: totalTokensOut,
    cacheReadTokens: totalCacheReadTokens,
  });

  for (let turn = 0; turn < config.maxSteps; turn++) {
    const startedAt = Date.now();
    const result = await client.complete({
      system: SYSTEM_PROMPT,
      messages,
      tools,
      maxTokens: config.maxTokens,
    });
    const latencyMs = result.latencyMs ?? Date.now() - startedAt;
    lastStopReason = result.stopReason;

    // Accounting spans every model turn, including the submit turn, so totals
    // reflect the real cost of the run.
    totalTokens += result.tokensIn + result.tokensOut;
    totalTokensIn += result.tokensIn;
    totalTokensOut += result.tokensOut;
    totalLatencyMs += latencyMs;
    costUsd += result.costUsd;
    const cacheRead = result.cacheReadTokens ?? 0;
    totalCacheReadTokens += cacheRead;
    totalCacheCreationTokens += result.cacheCreationTokens ?? 0;
    if (turn > 0) cacheReadAfterFirstTurn += cacheRead;

    // Record the assistant turn verbatim so the next request has full history.
    messages.push({ role: "assistant", content: result.content });

    const toolUses = result.content.filter((b) => b.type === "tool_use");

    if (toolUses.length === 0) {
      // The model answered with text and no tool call. Nudge it to act.
      messages.push({
        role: "user",
        content:
          "Use a read-only tool to gather evidence, or call submit_diagnosis when you are ready. Respond with a tool call.",
      });
      continue;
    }

    const toolResults: ModelToolResult[] = [];
    let firstStepOfTurn = true;
    let concluded: Diagnosis | null = null;

    for (const block of toolUses) {
      if (block.name === SUBMIT_DIAGNOSIS_TOOL) {
        // Instrumentation: every submit attempt records the turn's stop reason,
        // so a truncated turn is visible in the run output without a rerun.
        console.error(
          `[loop] submit_diagnosis attempt for "${scenarioId}": stop_reason=${result.stopReason}`,
        );
        const parsed = diagnosisSchema.safeParse(block.input);
        if (parsed.success) {
          concluded = parsed.data as Diagnosis;
          break;
        }
        // Invalid payload. Instrument it before deciding how to react: log the
        // raw input received and its top-level keys, so a truncated payload
        // (missing the trailing required fields) is distinguishable in the trace
        // from a genuinely malformed one.
        const topLevelKeys = Object.keys(block.input ?? {});
        console.error(
          `[loop] invalid submit_diagnosis for "${scenarioId}": ` +
            `stop_reason=${result.stopReason}; ` +
            `topLevelKeys=[${topLevelKeys.join(", ")}]; ` +
            `rawInput=${JSON.stringify(block.input)}`,
        );
        // Distinguish truncation from a bad submit. If this turn was cut off by
        // max_tokens, the trailing required fields never arrived. A correction
        // turn cannot help, since every retry truncates identically. Fail the run
        // with an unambiguous truncation reason instead of burning a correction.
        if (result.stopReason === "max_tokens") {
          throw new TruncatedOutputError(
            `model output truncated by max_tokens before completing the diagnosis ` +
              `for scenario "${scenarioId}"; the submit_diagnosis payload arrived with ` +
              `only [${topLevelKeys.join(", ")}]. Raise the model client max_tokens so ` +
              `the full tool payload fits.`,
            usageSoFar(),
          );
        }
        // Genuine validation failure. Do not retry with identical context. Return
        // the specific validation issues (each failing field path and message) as
        // an error tool_result so the model can resubmit a corrected diagnosis on
        // its next turn. Allow up to MAX_DIAGNOSIS_CORRECTIONS such turns; if it
        // still fails, fail the run cleanly so it is recorded, never looped.
        invalidSubmitCount++;
        if (invalidSubmitCount > MAX_DIAGNOSIS_CORRECTIONS) {
          throw new AgentRunError(
            `agent submitted an invalid diagnosis ${invalidSubmitCount} times for scenario "${scenarioId}"; last validation issues:\n${formatDiagnosisIssues(parsed.error)}`,
            usageSoFar(),
          );
        }
        toolResults.push({
          toolUseId: block.id,
          isError: true,
          content:
            "submit_diagnosis was rejected: the payload failed validation. " +
            "Fix exactly these problems and call submit_diagnosis again:\n" +
            formatDiagnosisIssues(parsed.error),
        });
        // A submit attempt is terminal intent for this turn. Ignore any other
        // tool calls in the same response.
        break;
      }

      // A read-only tool call. Resolve it through the provider. The same
      // normalized args object is hashed to the fixture key and passed to
      // resolve, so there is no place for the two to diverge.
      const call: ToolCall = {
        tool: block.name,
        args: normalizeArgs(block.input),
      };
      let output: string;
      let isError = false;
      try {
        const resolved = await provider.resolve(call);
        output = JSON.stringify(resolved.output);
      } catch (err) {
        isError = true;
        output = `tool error: ${err instanceof Error ? err.message : String(err)}`;
      }

      steps.push({
        index: steps.length,
        toolCall: call,
        // Attribute this turn's usage to its first investigative step so the
        // per-step totals sum to the run totals.
        latencyMs: firstStepOfTurn ? latencyMs : 0,
        tokensIn: firstStepOfTurn ? result.tokensIn : 0,
        tokensOut: firstStepOfTurn ? result.tokensOut : 0,
      });
      firstStepOfTurn = false;

      toolResults.push({ toolUseId: block.id, content: output, isError });
    }

    if (concluded) {
      // One-line cache summary per run. cacheReadAfterFirstTurn confirms that
      // later steps read earlier turns back from cache rather than reprocessing
      // them; it is zero for the fake client, which does no caching.
      console.error(
        `[loop] cache summary for "${scenarioId}": turns=${turn + 1}, ` +
          `uncachedIn=${totalTokensIn}, out=${totalTokensOut}, ` +
          `cacheRead=${totalCacheReadTokens} (afterFirstTurn=${cacheReadAfterFirstTurn}), ` +
          `cacheWrite=${totalCacheCreationTokens}`,
      );
      return {
        scenarioId,
        steps,
        diagnosis: concluded,
        stepCount: steps.length,
        totalTokens,
        tokensIn: totalTokensIn,
        tokensOut: totalTokensOut,
        cacheReadTokens: totalCacheReadTokens,
        costUsd,
        totalLatencyMs,
      };
    }

    // Feed the tool results back and continue the loop.
    messages.push({ role: "user", content: toolResults });
  }

  // Ran out of the step budget. If the final turn was truncated by max_tokens,
  // the agent was likely mid-diagnosis rather than genuinely stuck, so report it
  // as truncation, not a plain failure to converge.
  if (lastStopReason === "max_tokens") {
    throw new TruncatedOutputError(
      `model output truncated by max_tokens before completing the diagnosis for ` +
        `scenario "${scenarioId}" within ${config.maxSteps} steps. Raise the model ` +
        `client max_tokens so the full tool payload fits.`,
      usageSoFar(),
    );
  }

  throw new AgentRunError(
    `agent did not reach a diagnosis within ${config.maxSteps} steps for scenario "${scenarioId}"`,
    usageSoFar(),
  );
}
