// FakeModelClient: a scripted ModelClient for offline, deterministic runs.
//
// It ignores the conversation content and instead walks a fixed script of
// responses, one per turn. Position is derived from how many assistant turns
// are already in the message history, so the client is stateless and can be
// reused across runs. This is what makes the committed eval reproducible and
// free: no network, no model, same output every time.
//
// The script is scenario specific. buildCrashloopScript and the three builders
// below drive the four currently-seeded scenarios. Each walks a plausible
// read-only investigation and then submits a valid one-shot diagnosis whose
// cited excerpts carry the scenario's expectedEvidence markers, so evidence
// recall is meaningful.
// TODO: add a script per scenario, or switch to AnthropicModelClient, as the
// remaining scenarios (four obvious classes and the two misleading tier) are
// seeded.

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

// The failing pod for the crashloopbackoff-bad-command scenario. The Deployment
// target is "checkout"; this is the pod it creates, as it appears in the
// committed fixtures. It is a fixture detail, so it lives with the script.
const CRASHLOOP_POD = "checkout-6fff987c78-27bm6";

// A plausible investigation for the crashloopbackoff-bad-command scenario:
// list pods, describe the failing pod, read events, read the previous logs,
// then submit a grounded diagnosis. The cited excerpts match signals present in
// the committed fixtures, so evidence recall is meaningful.
export function buildCrashloopScript(namespace: string): CompletionResult[] {
  const pod = CRASHLOOP_POD;
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
                  "container checkout is waiting with reason CrashLoopBackOff and restartCount 10",
              },
              {
                tool: "describe_pod",
                args: { namespace, pod },
                excerpt:
                  "container checkout is waiting in CrashLoopBackOff, last terminated with a non-zero exit (reason Error)",
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

// A terminal submit_diagnosis step. The submit turn tends to emit more output
// tokens than an investigative turn, so it carries its own token count.
function submitStep(
  callId: string,
  input: Record<string, unknown>,
): CompletionResult {
  return {
    content: [{ type: "tool_use", id: callId, name: SUBMIT_DIAGNOSIS_TOOL, input }],
    stopReason: "tool_use",
    tokensIn: FAKE_TOKENS_IN,
    tokensOut: 160,
    costUsd: 0,
    latencyMs: FAKE_LATENCY_MS,
  };
}

// The Pending pod for the pod-unschedulable scenario. The Deployment target is
// "aggregator"; this is the pod it creates. It is a fixture detail, so it lives
// with the script. After a real capture, align this to the captured pod name.
const UNSCHEDULABLE_POD = "aggregator-7c9d8f6b54-mn2xk";

// A plausible investigation for pod-unschedulable: list pods, describe the
// Pending pod, read events, then diagnose from the FailedScheduling event. The
// pod never runs a container, so this path never reads logs, matching the
// captureSet. Cited excerpts carry the "FailedScheduling" and "Insufficient
// memory" markers.
export function buildUnschedulableScript(namespace: string): CompletionResult[] {
  const pod = UNSCHEDULABLE_POD;
  return [
    step("call-0", "get_pods", { namespace }),
    step("call-1", "describe_pod", { namespace, pod }),
    step("call-2", "get_events", { namespace }),
    submitStep("call-3", {
      failureClass: "PodUnschedulable",
      rootCause:
        "The aggregator pod requests more memory than any node in the cluster can provide, so the scheduler cannot place it. The pod stays Pending and no container ever starts.",
      evidence: [
        {
          tool: "get_pods",
          args: { namespace },
          excerpt:
            "pod aggregator is Pending with 0/1 containers ready and no node assigned",
        },
        {
          tool: "describe_pod",
          args: { namespace, pod },
          excerpt:
            "pod phase Pending, PodScheduled condition is False, no node assigned",
        },
        {
          tool: "get_events",
          args: { namespace },
          excerpt:
            "Warning FailedScheduling: 0/1 nodes are available: 1 Insufficient memory.",
        },
      ],
      suggestedFix:
        "Lower the pod's memory request to fit an available node, or add a node with enough memory, then let the deployment reschedule. This is advice only; the tool applies nothing.",
      confidence: 0.9,
    }),
  ];
}

// The backing pod for the service-no-endpoints scenario. The Deployment is named
// "web"; this is the pod it creates. Align to the captured pod name after a real
// capture.
const NOENDPOINTS_POD = "web-5b4c7d9f8a-qr7tp";

// A plausible investigation for service-no-endpoints: list pods (healthy),
// describe a pod to see its labels, read the service endpoints (empty), then
// diagnose the selector/label mismatch. No crashing pod, so no logs. Cited
// excerpts carry the "web-api" (selector) and "web-backend" (pod label) markers.
export function buildServiceNoEndpointsScript(
  namespace: string,
): CompletionResult[] {
  const pod = NOENDPOINTS_POD;
  const service = "web";
  return [
    step("call-0", "get_pods", { namespace }),
    step("call-1", "describe_pod", { namespace, pod }),
    step("call-2", "get_service_endpoints", { namespace, service }),
    submitStep("call-3", {
      failureClass: "ServiceNoEndpoints",
      rootCause:
        "The web Service selects pods with label app=web-api, but the running pods are labeled app=web-backend. The selector matches no pods, so the Service has no endpoints and cannot route traffic.",
      evidence: [
        {
          tool: "get_pods",
          args: { namespace },
          excerpt: "pod web-5b4c7d9f8a-qr7tp is Running and Ready (1/1)",
        },
        {
          tool: "describe_pod",
          args: { namespace, pod },
          excerpt: "pod labels include app=web-backend",
        },
        {
          tool: "get_service_endpoints",
          args: { namespace, service },
          excerpt:
            "Service web selector app=web-api resolves to zero endpoint addresses",
        },
      ],
      suggestedFix:
        "Align the Service selector with the pod labels (set the selector to app=web-backend) or relabel the pods so the selector matches. This is advice only; the tool applies nothing.",
      confidence: 0.9,
    }),
  ];
}

// The Running pod for the rbac-denied scenario. The Deployment is named
// "log-shipper"; this is the pod it creates. Align to the captured pod name
// after a real capture.
const RBAC_POD = "log-shipper-6d8b9c7f5e-zk4wm";

// A plausible investigation for rbac-denied: list pods (Running), describe the
// pod to see its ServiceAccount, check_rbac for the permission it needs, then
// diagnose the denial. The pod is healthy; the fault is the RBAC denial. Cited
// excerpts carry the "log-shipper" (SA), "list" (verb), and "secrets" (resource)
// markers as check_rbac reports them.
export function buildRbacDeniedScript(namespace: string): CompletionResult[] {
  const pod = RBAC_POD;
  const serviceAccount = "log-shipper";
  return [
    step("call-0", "get_pods", { namespace }),
    step("call-1", "describe_pod", { namespace, pod }),
    step("call-2", "check_rbac", {
      namespace,
      serviceAccount,
      verb: "list",
      resource: "secrets",
    }),
    submitStep("call-3", {
      failureClass: "RbacDenied",
      rootCause:
        "The log-shipper workload runs under the log-shipper ServiceAccount, which is bound to no Role granting list on secrets. Its requests to list secrets are denied, so the workload cannot do its job even though the pod runs.",
      evidence: [
        {
          tool: "get_pods",
          args: { namespace },
          excerpt: "pod log-shipper-6d8b9c7f5e-zk4wm is Running (1/1)",
        },
        {
          tool: "describe_pod",
          args: { namespace, pod },
          excerpt: "pod runs under serviceAccount log-shipper",
        },
        {
          tool: "check_rbac",
          args: { namespace, serviceAccount, verb: "list", resource: "secrets" },
          excerpt:
            "check_rbac reports serviceAccount log-shipper is not allowed to list secrets (allowed: false)",
        },
      ],
      suggestedFix:
        "Grant the log-shipper ServiceAccount a Role with list on secrets and bind it with a RoleBinding, if the workload truly needs that access. This is advice only; the tool applies nothing.",
      confidence: 0.9,
    }),
  ];
}

// A variant of the crashloop script that exercises the self-correction path.
// The first submit_diagnosis omits confidence and suggestedFix, so it fails the
// Diagnosis schema. The loop returns the validation issues, and the next turn
// submits the same, now-valid diagnosis. Position is derived from assistant-turn
// count, so the rejected submit advances the script exactly like any other turn.
// This lets an offline test assert that an invalid submit is surfaced and then
// self-corrected, deterministically and with no API key.
export function buildCrashloopSelfCorrectionScript(
  namespace: string,
): CompletionResult[] {
  const base = buildCrashloopScript(namespace);
  const validSubmit = base[base.length - 1];
  const investigative = base.slice(0, base.length - 1);

  const submitBlock = validSubmit.content[0];
  if (submitBlock.type !== "tool_use") {
    throw new Error(
      "expected the final crashloop step to be a submit_diagnosis tool_use",
    );
  }

  // Same diagnosis, minus the two required fields the real run forgot.
  const invalidInput: Record<string, unknown> = { ...submitBlock.input };
  delete invalidInput.confidence;
  delete invalidInput.suggestedFix;

  const invalidSubmit: CompletionResult = {
    content: [
      {
        type: "tool_use",
        id: "call-invalid-submit",
        name: SUBMIT_DIAGNOSIS_TOOL,
        input: invalidInput,
      },
    ],
    stopReason: "tool_use",
    tokensIn: FAKE_TOKENS_IN,
    tokensOut: 120,
    costUsd: 0,
    latencyMs: FAKE_LATENCY_MS,
  };

  return [...investigative, invalidSubmit, validSubmit];
}
