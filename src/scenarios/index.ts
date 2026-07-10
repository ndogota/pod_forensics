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
import configmapVolumeMissingGroundTruth from "./configmap-volume-missing/groundtruth.json";

export const SCENARIOS: Scenario[] = [
  {
    id: "crashloopbackoff-bad-command",
    description:
      "A Deployment whose container command exits non-zero on start, driving the pod into CrashLoopBackOff.",
    namespace: "shop",
    target: { kind: "Deployment", name: "checkout" },
    manifestsPath: "src/scenarios/crashloopbackoff-bad-command/manifests.yaml",
    groundTruth: crashloopGroundTruth as GroundTruth,
    // Obvious tier. The container's log line names a missing "--config" flag,
    // which reads like a decoy toward rootCauseClass MissingConfigOrSecret even
    // though the true cause is BadCommand. It was briefly classed misleading on
    // that theory, but an 8-run measurement showed the agent reliably identifies
    // BadCommand here (causeAccuracy 1.00 over 8 runs): it reasons past the log
    // string rather than grep-matching it. So this is an honest obvious case, not
    // a trap. See groundtruth.json, which still records the "--config" line as the
    // present-but-non-decisive signal it is.
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
  {
    id: "configmap-volume-missing",
    description:
      "A Deployment whose pod mounts a ConfigMap as a volume where the referenced ConfigMap does not exist, so the pod cannot start and sits in ContainerCreating (phase Pending).",
    namespace: "cms",
    target: { kind: "Deployment", name: "renderer" },
    manifestsPath: "src/scenarios/configmap-volume-missing/manifests.yaml",
    groundTruth: configmapVolumeMissingGroundTruth as GroundTruth,
    // Misleading tier. The surface signal is "the pod will not start": phase
    // Pending, container waiting in ContainerCreating, no logs. A shallow agent
    // may read that as a generic scheduling or startup fault and stop there,
    // landing on the wrong cause the way the Pending unschedulable scenario looks.
    // The true cause is a missing ConfigMap: the renderer-config object the volume
    // references does not exist. The discriminating move is to read the
    // FailedMount event that names renderer-config and then probe get_configmap
    // for it and see it absent, which pins the cause to MissingConfigOrSecret. The
    // container image and command are healthy, so nothing in the workload itself
    // is at fault. That gap between reading the not-running symptom and reasoning
    // to the absent object is what the misleading tier measures.
    tier: "misleading",
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
