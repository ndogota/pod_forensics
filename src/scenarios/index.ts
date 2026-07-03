// Scenario registry: data as code.
//
// Each entry is a frozen Scenario. The namespace under diagnosis and the target
// workload are fields on the Scenario itself, so no runtime wrapper is needed.
// Quest 1 seeds one scenario. See TEMPLATE.md to add more.

import type { GroundTruth, Scenario } from "../core/types";
import crashloopGroundTruth from "./crashloopbackoff-bad-command/groundtruth.json";

export const SCENARIOS: Scenario[] = [
  {
    id: "crashloopbackoff-bad-command",
    description:
      "A Deployment whose container command exits non-zero on start, driving the pod into CrashLoopBackOff.",
    namespace: "shop",
    target: { kind: "Deployment", name: "checkout" },
    manifestsPath: "src/scenarios/crashloopbackoff-bad-command/manifests.yaml",
    groundTruth: crashloopGroundTruth as GroundTruth,
    tier: "obvious",
  },
];

// TODO: nine more scenarios to seed per the architecture doc: seven more obvious
// tier (one per remaining failure class) and two misleading tier. Add each as a
// directory plus a registry entry here. See TEMPLATE.md.

export function findScenario(id: string): Scenario | undefined {
  return SCENARIOS.find((s) => s.id === id);
}
