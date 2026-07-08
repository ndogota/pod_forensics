// captureSpec for rbac-denied.
//
// The workload runs fine (the pod is Running), but its ServiceAccount is bound
// to no Role granting the permission it needs, so its API calls are denied. The
// discriminating signal is the check_rbac denial for that ServiceAccount on the
// specific verb and resource, not a crash. The read surface centers on check_rbac
// (declared in the surface), with the per-pod describe_pod and get_logs reads to
// show the pod is Running under the named ServiceAccount; the logs come back with
// content or empty for the sleeping container and are recorded either way.
//
// The surface also declares describe_deployment for the log-shipper workload and
// a ConfigMap and Secret probe named after the workload. Neither exists, so the
// not-found negatives are captured; probing a Secret is safe because
// get_secret_meta returns existence and key names only, never values.
//
// check_rbac issues a SubjectAccessReview against the workload identity
// system:serviceaccount:<namespace>:<serviceAccount> (see LiveProvider), so it
// reports the workload's access, not the caller's.
//
// Wait predicate: the pod is Running and check_rbac reports allowed=false for
// the ServiceAccount on list/secrets. The denial is deterministic (an unbound
// ServiceAccount cannot list secrets), so this does not depend on the workload
// actually attempting the call at runtime.

import { normalizeArgs } from "../../core/tools/argsHash";
import type { CheckRbacOutput, GetPodsOutput } from "../../core/tools";
import { findPodByPrefix, type CaptureSpec } from "../captureSpec";

// The permission the log-shipper workload needs and is denied. Echoed verbatim
// in the check_rbac fixture, so the expectedEvidence markers (the ServiceAccount,
// verb, and resource) literally appear.
const SERVICE_ACCOUNT = "log-shipper";
const VERB = "list";
const RESOURCE = "secrets";

export const captureSpec: CaptureSpec = {
  surface: {
    deployment: "log-shipper",
    configmaps: ["log-shipper"],
    secrets: ["log-shipper"],
    rbac: { serviceAccount: SERVICE_ACCOUNT, verb: VERB, resource: RESOURCE },
  },
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
      return { done: false, pod: "", detail: "workload pod not created yet" };
    }
    const running = pod.phase === "Running";

    const rbacResult = await provider.resolve({
      tool: "check_rbac",
      args: normalizeArgs({
        namespace: scenario.namespace,
        serviceAccount: SERVICE_ACCOUNT,
        verb: VERB,
        resource: RESOURCE,
      }),
    });
    const denied = (rbacResult.output as CheckRbacOutput).allowed === false;

    const done = running && denied;
    return {
      done,
      pod: pod.name,
      detail:
        `pod ${pod.name} phase=${pod.phase} ` +
        `${SERVICE_ACCOUNT} allowed(${VERB} ${RESOURCE})=${!denied}`,
    };
  },
};
