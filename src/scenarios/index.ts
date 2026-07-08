// Scenario registry: data as code.
//
// Each entry is a frozen Scenario. The namespace under diagnosis and the target
// workload are fields on the Scenario itself, so no runtime wrapper is needed.
// Quest 1 seeds one scenario. See TEMPLATE.md to add more.

import type { GroundTruth, Scenario } from "../core/types";
import crashloopGroundTruth from "./crashloopbackoff-bad-command/groundtruth.json";
import unschedulableGroundTruth from "./pod-unschedulable/groundtruth.json";
import serviceNoEndpointsGroundTruth from "./service-no-endpoints/groundtruth.json";
import rbacDeniedGroundTruth from "./rbac-denied/groundtruth.json";

export const SCENARIOS: Scenario[] = [
  {
    id: "crashloopbackoff-bad-command",
    description:
      "A Deployment whose container command exits non-zero on start, driving the pod into CrashLoopBackOff.",
    namespace: "shop",
    target: { kind: "Deployment", name: "checkout" },
    manifestsPath: "src/scenarios/crashloopbackoff-bad-command/manifests.yaml",
    groundTruth: crashloopGroundTruth as GroundTruth,
    // TODO: the container's log line mentions a missing "--config" flag, which is
    // an accidental misleading signal: it invites a MissingConfigOrSecret cause,
    // but the true rootCauseClass is BadCommand (the command exits non-zero) and
    // creating a ConfigMap would not fix it. A real run already misclassified the
    // cause on exactly this cue. Good candidate to promote to tier "misleading".
    tier: "obvious",
  },
  {
    id: "pod-unschedulable",
    description:
      "A Deployment whose pod requests more memory than any node can satisfy, so it never schedules and stays Pending with no container running.",
    namespace: "analytics",
    target: { kind: "Deployment", name: "aggregator" },
    manifestsPath: "src/scenarios/pod-unschedulable/manifests.yaml",
    groundTruth: unschedulableGroundTruth as GroundTruth,
    tier: "obvious",
  },
  {
    id: "service-no-endpoints",
    description:
      "Healthy Running pods plus a Service whose selector does not match the pod labels, so the Service has no endpoints.",
    namespace: "storefront",
    target: { kind: "Service", name: "web" },
    manifestsPath: "src/scenarios/service-no-endpoints/manifests.yaml",
    groundTruth: serviceNoEndpointsGroundTruth as GroundTruth,
    tier: "obvious",
  },
  {
    id: "rbac-denied",
    description:
      "A Running workload whose ServiceAccount is bound to no Role, so its calls to list secrets are denied by RBAC.",
    namespace: "telemetry",
    target: { kind: "Deployment", name: "log-shipper" },
    manifestsPath: "src/scenarios/rbac-denied/manifests.yaml",
    groundTruth: rbacDeniedGroundTruth as GroundTruth,
    tier: "obvious",
  },
];

// TODO: six more scenarios to seed per the architecture doc. Obvious tier, one
// per remaining failure class: ImagePullBackOff, OOMKilled, ProbeMisconfigured,
// MissingConfigOrSecret. Misleading tier: the two scenarios where the obvious
// surface signal is a symptom of a different root cause. Add each as a directory
// plus a registry entry here and a CaptureSpec in captureRegistry.ts. See
// TEMPLATE.md.

export function findScenario(id: string): Scenario | undefined {
  return SCENARIOS.find((s) => s.id === id);
}
