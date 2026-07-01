// Scenario registry: data as code.
//
// Each entry pairs a frozen Scenario with the runtime details a run needs but
// the Scenario contract does not carry: the single namespace under diagnosis
// and the failing pod. Quest 1 seeds one scenario. See TEMPLATE.md to add more.

import type { GroundTruth, Scenario } from "../core/types";
import crashloopGroundTruth from "./crashloopbackoff-bad-command/groundtruth.json";

export interface ScenarioRuntime {
  scenario: Scenario;
  namespace: string;
  pod: string;
}

export const SCENARIOS: ScenarioRuntime[] = [
  {
    scenario: {
      id: "crashloopbackoff-bad-command",
      description:
        "A Deployment whose container command exits non-zero on start, driving the pod into CrashLoopBackOff.",
      manifestsPath:
        "src/scenarios/crashloopbackoff-bad-command/manifests.yaml",
      groundTruth: crashloopGroundTruth as GroundTruth,
      tier: "obvious",
    },
    namespace: "shop",
    pod: "checkout-6f9c8b7d54-q4m2p",
  },
];

// TODO: nine more scenarios to seed per the architecture doc: seven more obvious
// tier (one per remaining failure class) and two misleading tier. Add each as a
// directory plus a registry entry here. See TEMPLATE.md.

export function findScenario(id: string): ScenarioRuntime | undefined {
  return SCENARIOS.find((s) => s.scenario.id === id);
}
