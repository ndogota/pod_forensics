// captureSpec for crashloopbackoff-bad-command.
//
// The wait predicate and the declared read surface for this scenario. It lives
// beside the scenario data, not on the frozen Scenario type, so scenario identity
// in core/types stays untouched.
//
// The shared buildReadSurface routine expands the surface metadata into the full
// set of read-only calls: get_pods, get_events, and per pod describe_pod plus
// both get_logs variants (a crash loop leaves its evidence in the prior
// terminated instance, read via previous=true). The surface adds
// describe_deployment for the checkout workload. buildReadSurface also probes a
// ConfigMap and Secret named after the deployment ("checkout"). Neither exists, so
// the not-found result is recorded on purpose: the container's error mentions a
// missing --config flag, so an exploring agent probes for a ConfigMap, and the
// captured negative lets it rule MissingConfigOrSecret out and land on the bad
// command.
//
// The failing pod name carries a Deployment's random template suffix, so it is
// not known until the pod exists. The predicate resolves it from the live
// cluster, and the harness resolves the full pod list live from get_pods before
// building the surface. After capture, the deterministic fake client is aligned
// to the same pod name (see fakeModelClient.ts) so its scripted calls hash to
// these same fixtures.

import { canonicalizeToolArgs } from "../../core/tools/canonicalizeToolArgs";
import type { GetPodsOutput } from "../../core/tools";
import { findPodByPrefix, type CaptureSpec } from "../captureSpec";

export const captureSpec: CaptureSpec = {
  surface: {
    // buildReadSurface probes get_configmap and get_secret_meta for the
    // deployment name ("checkout") structurally, so neither is listed here.
    deployment: "checkout",
  },
  // The failure is manifested once the target container is waiting in
  // CrashLoopBackOff or has restarted enough times that the loop is unambiguous.
  // CrashLoopBackOff backoff is itself exponential, so this can take a minute or
  // two to settle; the harness backoff accommodates that.
  async poll({ provider, scenario }) {
    const result = await provider.resolve({
      tool: "get_pods",
      args: canonicalizeToolArgs("get_pods", { namespace: scenario.namespace }),
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
};
