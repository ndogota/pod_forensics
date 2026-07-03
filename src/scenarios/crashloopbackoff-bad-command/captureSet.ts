// captureSpec for crashloopbackoff-bad-command.
//
// The wait predicate and the list of read-only tool calls the capture harness
// records into fixtures for this scenario. It lives beside the scenario data,
// not on the frozen Scenario type, so scenario identity in core/types stays
// untouched.
//
// Every call builds its args through the shared normalizeArgs, so the fixture
// filename (tool + argsHash) matches exactly what the FixtureProvider computes on
// replay. get_logs is captured with previous true, since a crash loop leaves its
// evidence in the prior terminated instance.
//
// The failing pod name carries a Deployment's random template suffix, so it is
// not known until the pod exists. The predicate resolves it from the live
// cluster and the harness threads it into buildCaptureSet. After capture, the
// deterministic fake client is aligned to the same pod name (see
// fakeModelClient.ts) so its scripted calls hash to these same fixtures.

import { normalizeArgs } from "../../core/tools/argsHash";
import type { GetPodsOutput } from "../../core/tools";
import type { ToolCall } from "../../core/types";
import { findPodByPrefix, type CaptureSpec } from "../captureSpec";

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

export const captureSpec: CaptureSpec = {
  // The failure is manifested once the target container is waiting in
  // CrashLoopBackOff or has restarted enough times that the loop is unambiguous.
  // CrashLoopBackOff backoff is itself exponential, so this can take a minute or
  // two to settle; the harness backoff accommodates that.
  async poll({ provider, scenario }) {
    const result = await provider.resolve({
      tool: "get_pods",
      args: normalizeArgs({ namespace: scenario.namespace }),
    });
    const pods = (result.output as GetPodsOutput).pods;
    const pod = findPodByPrefix(pods, scenario.target.name);
    if (!pod) {
      return { done: false, pod: "", detail: "target pod not scheduled yet" };
    }
    const status = pod.containerStatuses[0];
    const done = pod.containerStatuses.some(
      (c) => c.reason === "CrashLoopBackOff" || c.restartCount >= 3,
    );
    return {
      done,
      pod: pod.name,
      detail:
        `pod ${pod.name} phase=${pod.phase} restarts=${pod.restarts} ` +
        `reason=${status?.reason ?? "-"}`,
    };
  },
  buildCaptureSet,
};
