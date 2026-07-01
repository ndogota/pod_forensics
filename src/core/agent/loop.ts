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
import type { Diagnosis, RunTrace, ToolCall, TraceStep } from "../types";
import { DEFAULT_AGENT_CONFIG, type AgentConfig } from "./config";
import {
  SUBMIT_DIAGNOSIS_TOOL,
  diagnosisSchema,
  submitDiagnosisDefinition,
} from "./diagnosisSchema";
import type {
  ModelClient,
  ModelMessage,
  ModelTool,
  ModelToolResult,
} from "./modelClient";
import { SYSTEM_PROMPT, buildInitialUserPrompt } from "./prompts";

export interface RunAgentOptions {
  scenarioId: string;
  namespace: string;
  provider: ToolProvider;
  client: ModelClient;
  config?: AgentConfig;
}

// Thrown when the agent fails to produce a valid diagnosis within the step
// budget, including after one retry on an invalid submit_diagnosis payload.
export class AgentRunError extends Error {}

// Coerce a model tool input into the stringly-typed args a ToolCall carries.
// ToolCall.args is Record<string, string>, so booleans and numbers become
// strings here. This is also what the fixture argshash is computed over.
function toArgs(input: Record<string, unknown>): Record<string, string> {
  const args: Record<string, string> = {};
  for (const [k, v] of Object.entries(input)) {
    if (v === undefined || v === null) continue;
    args[k] = String(v);
  }
  return args;
}

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
        // Invalid diagnosis. Retry once, then fail cleanly.
        invalidSubmitCount++;
        if (invalidSubmitCount > 1) {
          throw new AgentRunError(
            `agent submitted an invalid diagnosis twice for scenario "${scenarioId}": ${parsed.error.message}`,
          );
        }
        toolResults.push({
          toolUseId: block.id,
          isError: true,
          content: `The diagnosis did not match the required shape. Fix these problems and call submit_diagnosis again: ${parsed.error.message}`,
        });
        // A submit attempt is terminal intent for this turn. Ignore any other
        // tool calls in the same response.
        break;
      }

      // A read-only tool call. Resolve it through the provider.
      const call: ToolCall = { tool: block.name, args: toArgs(block.input) };
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
