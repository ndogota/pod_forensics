// Capture registry: scenario id to its CaptureSpec.
//
// The capture harness looks a scenario up here to get its wait predicate and
// captureSet. Adding a scenario means adding its directory (manifests,
// groundtruth, captureSet) and one line here, so the harness itself stays
// scenario-agnostic.

import { captureSpec as crashloopSpec } from "./crashloopbackoff-bad-command/captureSet";
import { captureSpec as unschedulableSpec } from "./pod-unschedulable/captureSet";
import { captureSpec as serviceNoEndpointsSpec } from "./service-no-endpoints/captureSet";
import { captureSpec as rbacDeniedSpec } from "./rbac-denied/captureSet";
import { captureSpec as configmapVolumeMissingSpec } from "./configmap-volume-missing/captureSet";
import type { CaptureSpec } from "./captureSpec";

export const CAPTURE_SPECS: Record<string, CaptureSpec> = {
  "crashloopbackoff-bad-command": crashloopSpec,
  "pod-unschedulable": unschedulableSpec,
  "service-no-endpoints": serviceNoEndpointsSpec,
  "rbac-denied": rbacDeniedSpec,
  "configmap-volume-missing": configmapVolumeMissingSpec,
};

// TODO: add a CaptureSpec for each remaining scenario as it is seeded: the three
// other obvious-tier classes (ImagePullBackOff, OOMKilled, ProbeMisconfigured)
// and the two misleading-tier scenarios. See src/scenarios/TEMPLATE.md.

export function findCaptureSpec(scenarioId: string): CaptureSpec | undefined {
  return CAPTURE_SPECS[scenarioId];
}
