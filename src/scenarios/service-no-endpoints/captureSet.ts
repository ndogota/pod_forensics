// captureSpec for service-no-endpoints.
//
// The pods are healthy and Running, but the Service selector matches none of
// their labels, so the Service has no endpoints. There is no crashing pod; the
// failure is purely a label/selector mismatch. The captureSet centers on
// get_service_endpoints (which exposes the selector and the empty address list)
// and get_pods, plus describe_pod so the pod's actual labels are visible next to
// the selector that fails to match them.
//
// Wait predicate: the target pod is Running and Ready, and the Service resolves
// to zero endpoint addresses. Both the Deployment and the Service share the
// scenario target name, so the pod prefix matches the target name.

import { normalizeArgs } from "../../core/tools/argsHash";
import type {
  GetPodsOutput,
  GetServiceEndpointsOutput,
} from "../../core/tools";
import type { ToolCall } from "../../core/types";
import { findPodByPrefix, type CaptureSpec } from "../captureSpec";

export function buildCaptureSet(namespace: string, pod: string): ToolCall[] {
  const service = "web";
  return [
    { tool: "get_pods", args: normalizeArgs({ namespace }) },
    { tool: "describe_pod", args: normalizeArgs({ namespace, pod }) },
    {
      tool: "get_service_endpoints",
      args: normalizeArgs({ namespace, service }),
    },
  ];
}

export const captureSpec: CaptureSpec = {
  async poll({ provider, scenario }) {
    const podsResult = await provider.resolve({
      tool: "get_pods",
      args: normalizeArgs({ namespace: scenario.namespace }),
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
      args: normalizeArgs({ namespace: scenario.namespace, service: "web" }),
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
  buildCaptureSet,
};
