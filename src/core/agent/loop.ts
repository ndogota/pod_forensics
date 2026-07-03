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

// Thrown when the agent fails to produce a valid diagnosis within the step
// budget, including after up to MAX_DIAGNOSIS_CORRECTIONS informed correction
// turns on an invalid submit_diagnosis payload.
export class AgentRunError extends Error {}

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
  let totalLatencyMs = 0;
  let costUsd = 0;
  let invalidSubmitCount = 0;

  for (let turn = 0; turn < config.maxSteps; turn++) {
    const startedAt = Date.now();
    const result = await client.complete({
      system: SYSTEM_PROMPT,
      messages,
      tools,
      maxTokens: config.maxTokens,
    });
    const latencyMs = result.latencyMs ?? Date.now() - startedAt;

    // Accounting spans every model turn, including the submit turn, so totals
    // reflect the real cost of the run.
    totalTokens += result.tokensIn + result.tokensOut;
    totalLatencyMs += latencyMs;
    costUsd += result.costUsd;

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
        const parsed = diagnosisSchema.safeParse(block.input);
        if (parsed.success) {
          concluded = parsed.data as Diagnosis;
          break;
        }
        // Invalid diagnosis. Do not retry with identical context. Return the
        // specific validation issues (each failing field path and message) as an
        // error tool_result so the model can resubmit a corrected diagnosis on
        // its next turn. Allow up to MAX_DIAGNOSIS_CORRECTIONS such turns; if it
        // still fails, fail the run cleanly so it is recorded, never looped.
        invalidSubmitCount++;
        if (invalidSubmitCount > MAX_DIAGNOSIS_CORRECTIONS) {
          throw new AgentRunError(
            `agent submitted an invalid diagnosis ${invalidSubmitCount} times for scenario "${scenarioId}"; last validation issues:\n${formatDiagnosisIssues(parsed.error)}`,
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
      return {
        scenarioId,
        steps,
        diagnosis: concluded,
        stepCount: steps.length,
        totalTokens,
        costUsd,
        totalLatencyMs,
      };
    }

    // Feed the tool results back and continue the loop.
    messages.push({ role: "user", content: toolResults });
  }

  throw new AgentRunError(
    `agent did not reach a diagnosis within ${config.maxSteps} steps for scenario "${scenarioId}"`,
  );
}
