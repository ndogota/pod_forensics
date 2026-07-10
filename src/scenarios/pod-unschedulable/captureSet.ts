// captureSpec for pod-unschedulable.
//
// The pod never schedules (its memory request exceeds every node), so no
// container ever runs. The discriminating signal lives in the scheduler's
// FailedScheduling event, not in logs. The shared read surface still records both
// get_logs variants per pod for uniformity: the Pending pod has no container, so
// those reads come back empty (or the harness logs and skips a read the cluster
// rejects for a never-started container). Empty logs are a legitimate captured
// signal, consistent with recording negatives, and they keep replay robust to an
// agent that reads logs before it realizes the pod never ran.
//
// The surface adds describe_deployment for the aggregator workload; buildReadSurface
// also probes a ConfigMap and Secret named after the deployment ("aggregator"),
// neither of which exists, so the not-found result is recorded and lets an agent
// rule MissingConfigOrSecret out.
//
// Wait predicate: a FailedScheduling event for the pod, or the pod sitting in
// phase Pending past a short grace period. The event is the signal we also want
// in the fixtures (expectedEvidence cites FailedScheduling and Insufficient
// memory), so preferring it guarantees the marker is present when captured.

import { canonicalizeToolArgs } from "../../core/tools/canonicalizeToolArgs";
import type { GetEventsOutput, GetPodsOutput } from "../../core/tools";
import { findPodByPrefix, type CaptureSpec } from "../captureSpec";

// A Pending pod that has not yet drawn a FailedScheduling event is only accepted
// after this grace period, so capture does not race the first scheduling
// attempt.
const PENDING_GRACE_MS = 20_000;

export const captureSpec: CaptureSpec = {
  surface: {
    // buildReadSurface probes get_configmap and get_secret_meta for the
    // deployment name ("aggregator") structurally, so neither is listed here.
    deployment: "aggregator",
  },
  async poll({ provider, scenario, elapsedMs }) {
    const podsResult = await provider.resolve({
      tool: "get_pods",
      args: canonicalizeToolArgs("get_pods", { namespace: scenario.namespace }),
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
      args: canonicalizeToolArgs("get_events", { namespace: scenario.namespace }),
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
};
