// captureSpec for pod-unschedulable.
//
// The pod never schedules (its memory request exceeds every node), so no
// container ever runs. The captureSet therefore does NOT read container logs:
// there is no running or previously-terminated container to read, and get_logs
// would be empty or error. The discriminating signal lives in the scheduler's
// FailedScheduling event, not in logs.
//
// Wait predicate: a FailedScheduling event for the pod, or the pod sitting in
// phase Pending past a short grace period. The event is the signal we also want
// in the fixtures (expectedEvidence cites FailedScheduling and Insufficient
// memory), so preferring it guarantees the marker is present when captured.

import { normalizeArgs } from "../../core/tools/argsHash";
import type { GetEventsOutput, GetPodsOutput } from "../../core/tools";
import type { ToolCall } from "../../core/types";
import { findPodByPrefix, type CaptureSpec } from "../captureSpec";

// A Pending pod that has not yet drawn a FailedScheduling event is only accepted
// after this grace period, so capture does not race the first scheduling
// attempt.
const PENDING_GRACE_MS = 20_000;

export function buildCaptureSet(namespace: string, pod: string): ToolCall[] {
  return [
    { tool: "get_pods", args: normalizeArgs({ namespace }) },
    { tool: "describe_pod", args: normalizeArgs({ namespace, pod }) },
    { tool: "get_events", args: normalizeArgs({ namespace }) },
  ];
}

export const captureSpec: CaptureSpec = {
  async poll({ provider, scenario, elapsedMs }) {
    const podsResult = await provider.resolve({
      tool: "get_pods",
      args: normalizeArgs({ namespace: scenario.namespace }),
    });
    const pod = findPodByPrefix(
      (podsResult.output as GetPodsOutput).pods,
      scenario.target.name,
    );
    if (!pod) {
      return { done: false, pod: "", detail: "target pod not created yet" };
    }

    const eventsResult = await provider.resolve({
      tool: "get_events",
      args: normalizeArgs({ namespace: scenario.namespace }),
    });
    const hasFailedScheduling = (
      eventsResult.output as GetEventsOutput
    ).events.some(
      (e) =>
        e.reason === "FailedScheduling" &&
        e.involvedObject === `Pod/${pod.name}`,
    );

    const pendingPastGrace =
      pod.phase === "Pending" && elapsedMs >= PENDING_GRACE_MS;
    const done = hasFailedScheduling || pendingPastGrace;
    return {
      done,
      pod: pod.name,
      detail:
        `pod ${pod.name} phase=${pod.phase} ` +
        `failedScheduling=${hasFailedScheduling}`,
    };
  },
  buildCaptureSet,
};
