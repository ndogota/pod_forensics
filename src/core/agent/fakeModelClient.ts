// FakeModelClient: a scripted ModelClient for offline, deterministic runs.
//
// It ignores the conversation content and instead walks a fixed script of
// responses, one per turn. Position is derived from how many assistant turns
// are already in the message history, so the client is stateless and can be
// reused across runs. This is what makes the committed eval reproducible and
// free: no network, no model, same output every time.
//
// The script is scenario specific. buildCrashloopScript below drives the
// crashloopbackoff-bad-command scenario.
// TODO: add a script per scenario, or switch to AnthropicModelClient, as more
// scenarios are seeded.

import { SUBMIT_DIAGNOSIS_TOOL } from "./diagnosisSchema";
import type {
  CompletionRequest,
  CompletionResult,
  ModelClient,
} from "./modelClient";

// Fixed, deterministic per-step usage. Cost is zero for the fake client.
const FAKE_TOKENS_IN = 600;
const FAKE_TOKENS_OUT = 90;
const FAKE_LATENCY_MS = 5;

function step(
  callId: string,
  name: string,
  input: Record<string, unknown>,
): CompletionResult {
  return {
    content: [{ type: "tool_use", id: callId, name, input }],
    stopReason: "tool_use",
    tokensIn: FAKE_TOKENS_IN,
    tokensOut: FAKE_TOKENS_OUT,
    costUsd: 0,
    latencyMs: FAKE_LATENCY_MS,
  };
}

export class FakeModelClient implements ModelClient {
  readonly model = "fake-model";
  private readonly script: CompletionResult[];

  constructor(script: CompletionResult[]) {
    this.script = script;
  }

  async complete(req: CompletionRequest): Promise<CompletionResult> {
    const position = req.messages.filter((m) => m.role === "assistant").length;
    if (position >= this.script.length) {
      throw new Error(
        `FakeModelClient script exhausted at step ${position}. The loop asked for more responses than the script provides.`,
      );
    }
    return this.script[position];
  }
}

// A plausible investigation for the crashloopbackoff-bad-command scenario:
// list pods, describe the failing pod, read events, read the previous logs,
// then submit a grounded diagnosis. The cited excerpts match signals present in
// the committed fixtures, so evidence recall is meaningful.
export function buildCrashloopScript(
  namespace: string,
  pod: string,
): CompletionResult[] {
  return [
    step("call-0", "get_pods", { namespace }),
    step("call-1", "describe_pod", { namespace, pod }),
    step("call-2", "get_events", { namespace }),
    step("call-3", "get_logs", { namespace, pod, previous: true }),
    {
      content: [
        {
          type: "tool_use",
          id: "call-4",
          name: SUBMIT_DIAGNOSIS_TOOL,
          input: {
            failureClass: "CrashLoopBackOff",
            rootCause:
              "The checkout container start command exits with a non-zero status immediately because the required --config flag is missing. The kubelet keeps restarting the container, so the pod settles into CrashLoopBackOff.",
            evidence: [
              {
                tool: "get_pods",
                args: { namespace },
                excerpt:
                  "container checkout is waiting with reason CrashLoopBackOff and restartCount 6",
              },
              {
                tool: "describe_pod",
                args: { namespace, pod },
                excerpt:
                  "last state terminated with exit code 1 (reason Error)",
              },
              {
                tool: "get_logs",
                args: { namespace, pod, previous: "true" },
                excerpt:
                  "previous logs show: FATAL: missing required flag --config",
              },
              {
                tool: "get_events",
                args: { namespace },
                excerpt:
                  "Warning BackOff: Back-off restarting failed container checkout",
              },
            ],
            suggestedFix:
              "Provide the required configuration to the checkout container. Set the --config flag to a valid path and mount the configuration the service expects, then let the deployment roll out. This is advice only; the tool applies nothing.",
            confidence: 0.9,
          },
        },
      ],
      stopReason: "tool_use",
      tokensIn: FAKE_TOKENS_IN,
      tokensOut: 160,
      costUsd: 0,
      latencyMs: FAKE_LATENCY_MS,
    },
  ];
}
