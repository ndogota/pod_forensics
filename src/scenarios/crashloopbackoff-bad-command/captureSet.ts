// captureSet for crashloopbackoff-bad-command.
//
// The list of read-only tool calls the capture harness records into fixtures for
// this scenario. It lives beside the scenario data, not on the frozen Scenario
// type, so scenario identity in core/types stays untouched.
//
// Every call builds its args through the shared normalizeArgs, so the fixture
// filename (tool + argsHash) matches exactly what the FixtureProvider computes on
// replay. get_logs is captured with previous true, since a crash loop leaves its
// evidence in the prior terminated instance.
//
// The failing pod name carries a Deployment's random template suffix, so it is
// not known until the pod exists. capture.ts resolves it from the live cluster
// and passes it here. After capture, the deterministic fake client is aligned to
// the same pod name (see fakeModelClient.ts) so its scripted calls hash to these
// same fixtures.

import { normalizeArgs } from "../../core/tools/argsHash";
import type { ToolCall } from "../../core/types";

export function buildCaptureSet(namespace: string, pod: string): ToolCall[] {
  return [
    { tool: "get_pods", args: normalizeArgs({ namespace }) },
    { tool: "describe_pod", args: normalizeArgs({ namespace, pod }) },
    { tool: "get_events", args: normalizeArgs({ namespace }) },
    {
      tool: "get_logs",
      args: normalizeArgs({ namespace, pod, previous: true }),
    },
  ];
}
