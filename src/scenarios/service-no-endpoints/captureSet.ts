// captureSpec for service-no-endpoints.
//
// The pods are healthy and Running, but the Service selector matches none of
// their labels, so the Service has no endpoints. There is no crashing pod; the
// failure is purely a label/selector mismatch. The read surface centers on
// get_service_endpoints (which exposes the selector and the empty address list),
// plus the per-pod describe_pod so the pod's actual labels are visible next to
// the selector that fails to match them. The per-pod get_logs reads come back
// with content or empty depending on the image; recording them keeps replay
// robust to an agent that reads logs while ruling a crash out.
//
// The surface declares the web Service (the empty endpoints are the smoking gun),
// describe_deployment for the web workload, and a ConfigMap and Secret probe
// named after the workload so the not-found negatives are captured.
//
// Wait predicate: the target pod is Running and Ready, and the Service resolves
// to zero endpoint addresses. Both the Deployment and the Service share the
// scenario target name, so the pod prefix matches the target name.

import { canonicalizeToolArgs } from "../../core/tools/canonicalizeToolArgs";
import type {
  GetPodsOutput,
  GetServiceEndpointsOutput,
} from "../../core/tools";
import { findPodByPrefix, type CaptureSpec } from "../captureSpec";

export const captureSpec: CaptureSpec = {
  surface: {
    deployment: "web",
    service: "web",
    configmaps: ["web"],
    secrets: ["web"],
  },
  async poll({ provider, scenario }) {
    const podsResult = await provider.resolve({
      tool: "get_pods",
      args: canonicalizeToolArgs("get_pods", { namespace: scenario.namespace }),
    });
    const pod = findPodByPrefix(
      (podsResult.output as GetPodsOutput).pods,
      scenario.target.name,
    );
    if (!pod) {
      return { done: false, pod: "", detail: "backing pod not created yet" };
    }
    const podReady =
      pod.phase === "Running" &&
      pod.containerStatuses.length > 0 &&
      pod.containerStatuses.every((c) => c.ready);

    const epResult = await provider.resolve({
      tool: "get_service_endpoints",
      args: canonicalizeToolArgs("get_service_endpoints", {
        namespace: scenario.namespace,
        service: "web",
      }),
    });
    const addresses = (epResult.output as GetServiceEndpointsOutput).addresses;
    const noEndpoints = addresses.length === 0;

    const done = podReady && noEndpoints;
    return {
      done,
      pod: pod.name,
      detail:
        `pod ${pod.name} phase=${pod.phase} ready=${pod.ready} ` +
        `endpoints=${addresses.length}`,
    };
  },
};
