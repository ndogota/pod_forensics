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
//
// Recapture resilience: a Deployment names its pod with a random template-hash
// suffix that capture cannot know ahead of time and that changes on every
// recapture. The scripts therefore never hardcode a pod name; each resolves it
// at run time from the scenario's committed get_pods fixture (resolvePodName),
// so the scripted describe_pod and get_logs calls always hash to the same
// fixtures the capture wrote, no matter what suffix the latest capture assigned.

import { readFileSync } from "node:fs";
import path from "node:path";

import { argsHash } from "../tools/argsHash";
import { canonicalizeToolArgs } from "../tools/canonicalizeToolArgs";
import type { GetPodsOutput } from "../tools";
import type { Scenario } from "../types";
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

// Resolve the pod name a scenario's fixtures were captured with, by reading its
// committed get_pods fixture and matching the workload-name prefix. This is the
// one place a script learns a pod name; nothing is hardcoded. Because the hash
// is derived from the same canonicalizeToolArgs/argsHash the FixtureProvider uses, and
// the pod name comes from the very get_pods fixture the agent replays, the
// scripted describe_pod and get_logs calls resolve to the committed fixtures
// even after a recapture assigns a fresh random suffix. Throws loudly if the
// fixture is missing or holds no matching pod, so a broken capture fails fast
// rather than silently missing fixtures.
function resolvePodName(scenario: Scenario): string {
  const hash = argsHash(
    canonicalizeToolArgs("get_pods", { namespace: scenario.namespace }),
  );
  const fixturePath = path.resolve(
    process.cwd(),
    "src/fixtures",
    scenario.id,
    `get_pods-${hash}.json`,
  );
  const raw = readFileSync(fixturePath, "utf8");
  const parsed = JSON.parse(raw) as { output: GetPodsOutput };
  const pod = parsed.output.pods.find((p) =>
    p.name.startsWith(`${scenario.target.name}-`),
  );
  if (!pod) {
    throw new Error(
      `fakeModelClient: no pod matching workload "${scenario.target.name}" in ` +
        `${fixturePath}. Recapture the "${scenario.id}" fixtures.`,
    );
  }
  return pod.name;
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
// the committed fixtures, so evidence recall is meaningful. The failing pod name
// is resolved from the committed get_pods fixture, never hardcoded.
export function buildCrashloopScript(scenario: Scenario): CompletionResult[] {
  const namespace = scenario.namespace;
  const pod = resolvePodName(scenario);
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

// A plausible investigation for pod-unschedulable: list pods, describe the
// Pending pod, read events, then diagnose from the FailedScheduling event. The
// pod never runs a container, so this path never reads logs, matching the
// captureSet. Cited excerpts carry the "FailedScheduling" and "Insufficient
// memory" markers. The Pending pod name is resolved from the committed get_pods
// fixture, never hardcoded.
export function buildUnschedulableScript(scenario: Scenario): CompletionResult[] {
  const namespace = scenario.namespace;
  const pod = resolvePodName(scenario);
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

// A plausible investigation for service-no-endpoints: list pods (healthy),
// describe a pod to see its labels, read the service endpoints (empty), then
// diagnose the selector/label mismatch. No crashing pod, so no logs. Cited
// excerpts carry the "web-api" (selector) and "web-backend" (pod label) markers.
// The backing pod name is resolved from the committed get_pods fixture, never
// hardcoded.
export function buildServiceNoEndpointsScript(
  scenario: Scenario,
): CompletionResult[] {
  const namespace = scenario.namespace;
  const pod = resolvePodName(scenario);
  const service = scenario.target.name;
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
          excerpt: `pod ${pod} is Running and Ready (1/1)`,
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

// A plausible investigation for rbac-denied: list pods (Running), describe the
// pod to see its ServiceAccount, read the current logs to find the Kubernetes
// Forbidden error the container prints, then check_rbac using the exact verb,
// resource, and service account that error names, and diagnose the denial. The
// pod is healthy; the fault is the RBAC denial. The Running pod name is resolved
// from the committed get_pods fixture, never hardcoded. Cited excerpts carry the
// "log-shipper" (SA), "list" (verb), and "secrets" (resource) markers, both from
// the forbidden log line and as check_rbac reports them, so evidence recall stays
// meaningful once groundtruth.json is set from the real capture.
export function buildRbacDeniedScript(scenario: Scenario): CompletionResult[] {
  const namespace = scenario.namespace;
  const pod = resolvePodName(scenario);
  const serviceAccount = scenario.target.name;
  return [
    step("call-0", "get_pods", { namespace }),
    step("call-1", "describe_pod", { namespace, pod }),
    step("call-2", "get_logs", { namespace, pod, previous: false }),
    step("call-3", "check_rbac", {
      namespace,
      serviceAccount,
      verb: "list",
      resource: "secrets",
    }),
    submitStep("call-4", {
      failureClass: "RbacDenied",
      rootCause:
        "The log-shipper workload runs under the log-shipper ServiceAccount, which is bound to no Role granting list on secrets. Its attempts to list secrets are denied by RBAC, which the container logs as a Kubernetes Forbidden error, so the workload cannot do its job even though the pod runs.",
      evidence: [
        {
          tool: "get_pods",
          args: { namespace },
          excerpt: `pod ${pod} is Running (1/1); the container is healthy, not crashing`,
        },
        {
          tool: "get_logs",
          args: { namespace, pod, previous: "false" },
          excerpt:
            `container stdout shows a Kubernetes Forbidden error: secrets is forbidden: ` +
            `User "system:serviceaccount:${namespace}:${serviceAccount}" cannot list ` +
            `resource "secrets" in API group "" in the namespace "${namespace}"`,
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
  scenario: Scenario,
): CompletionResult[] {
  const base = buildCrashloopScript(scenario);
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
