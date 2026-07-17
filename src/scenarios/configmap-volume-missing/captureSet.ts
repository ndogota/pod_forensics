// captureSpec for configmap-volume-missing.
//
// The wait predicate and the declared read surface for this scenario. It lives
// beside the scenario data, not on the frozen Scenario type, so scenario identity
// in core/types stays untouched.
//
// The shared buildReadSurface routine expands the surface metadata into the full
// set of read-only calls: get_pods, get_events, and per pod describe_pod plus
// both get_logs variants. The container here never starts (the volume cannot be
// populated from a ConfigMap that does not exist), so both log reads return an
// API error the LiveProvider encodes as a fixture rather than a stream; that
// negative is captured on purpose. The surface adds describe_deployment for the
// renderer workload and, critically, a probe of the ConfigMap the volume names.
// That ConfigMap does not exist, so the not-found result is recorded on purpose:
// the FailedMount event names renderer-config, so a reasoning agent probes
// get_configmap for it, and the captured negative is the discriminating signal
// that lands the diagnosis on MissingConfigOrSecret rather than a generic
// startup or scheduling fault. buildReadSurface also probes get_configmap and
// get_secret_meta for the deployment name "renderer" (the name an agent most often
// infers); neither exists, so both are captured as real not-found negatives.
//
// The failing pod name carries a Deployment's random template suffix, so it is
// not known until the pod exists. The predicate resolves it from the live
// cluster, and the harness resolves the full pod list live from get_pods before
// building the surface. After capture, the deterministic fake client is aligned
// to the same pod name (see fakeModelClient.ts) so its scripted calls hash to
// these same fixtures.

import { canonicalizeToolArgs } from "../../core/tools/canonicalizeToolArgs";
import type { GetEventsOutput, GetPodsOutput } from "../../core/tools";
import { findPodByPrefix, type CaptureSpec } from "../captureSpec";

// The ConfigMap the volume references. It is intentionally never created, so a
// probe of it returns not-found, and the kubelet's FailedMount event names it.
const MISSING_CONFIGMAP = "renderer-config";

// The pod may sit in ContainerCreating for a moment during normal startup, so the
// predicate does not fire on "not ready" alone. It waits until the failure is
// unambiguous: the kubelet has emitted the FailedMount event that names the
// missing ConfigMap, and a short grace period has elapsed so a transient
// ContainerCreating is not mistaken for the stuck state.
const GRACE_MS = 10_000;

// Does any event report the volume mount failing on the absent ConfigMap? This is
// the signal that the failure under test has manifested, not merely that the pod
// is briefly still creating.
function eventsReferenceMissingConfigmap(
  events: GetEventsOutput["events"],
): boolean {
  return events.some(
    (e) =>
      e.reason === "FailedMount" &&
      e.message.includes(`configmap "${MISSING_CONFIGMAP}" not found`),
  );
}

export const captureSpec: CaptureSpec = {
  surface: {
    deployment: "renderer",
    // Probe the ConfigMap the volume names. It does not exist, so the recorded
    // not-found is the discriminating signal for MissingConfigOrSecret.
    configmaps: [MISSING_CONFIGMAP],
  },
  // The failure is manifested once the pod is stuck not-Ready past the grace
  // period AND the kubelet has emitted the FailedMount event naming the missing
  // ConfigMap. The container never starts, so this state does not clear on its
  // own; the kubelet keeps retrying the mount and re-emitting the event.
  async poll({ provider, scenario, elapsedMs }) {
    const podsResult = await provider.resolve({
      tool: "get_pods",
      args: canonicalizeToolArgs("get_pods", { namespace: scenario.namespace }),
    });
    const pods = (podsResult.output as GetPodsOutput).pods;
    const pod = findPodByPrefix(pods, scenario.target.name);
    if (!pod) {
      return { done: false, pod: "", detail: "target pod not scheduled yet" };
    }

    const status = pod.containerStatuses[0];
    const ready = pod.containerStatuses.every((c) => c.ready);

    const eventsResult = await provider.resolve({
      tool: "get_events",
      args: canonicalizeToolArgs("get_events", {
        namespace: scenario.namespace,
      }),
    });
    const events = (eventsResult.output as GetEventsOutput).events;
    const mountFailed = eventsReferenceMissingConfigmap(events);

    const done = !ready && mountFailed && elapsedMs >= GRACE_MS;
    return {
      done,
      pod: pod.name,
      detail:
        `pod ${pod.name} phase=${pod.phase} ready=${pod.ready} ` +
        `reason=${status?.reason ?? "-"} mountFailedEvent=${mountFailed}`,
    };
  },
};
