// captureSpec for rbac-denied.
//
// The workload runs fine (the pod is Running), but its ServiceAccount is bound
// to no Role granting the permission it needs. The container actively attempts
// the denied action: it runs `kubectl get secrets` on a loop, which in-cluster
// authenticates as the pod ServiceAccount, so the API server forbids it and the
// container writes the canonical Kubernetes Forbidden error to stdout. That log
// line names the verb (list), the resource (secrets), and the subject
// system:serviceaccount:<ns>:<serviceAccount>, giving the agent a surface signal
// that tells it exactly which permission to test rather than guessing. The
// discriminating signals are therefore that forbidden log line plus the
// check_rbac denial for that same ServiceAccount/verb/resource, not a crash.
//
// The read surface centers on check_rbac (declared in the surface), with the
// per-pod describe_pod and get_logs reads to show the pod is Running under the
// named ServiceAccount and to capture the forbidden line in the current logs
// (previous=false). previous=true is recorded too and comes back as an apiError
// (the container never restarted).
//
// The surface also declares describe_deployment for the log-shipper workload;
// buildReadSurface probes a ConfigMap and Secret named after the deployment
// ("log-shipper"). Neither exists, so the not-found negatives are captured;
// probing a Secret is safe because get_secret_meta returns existence and key names
// only, never values.
//
// check_rbac issues a SubjectAccessReview against the workload identity
// system:serviceaccount:<namespace>:<serviceAccount> (see LiveProvider), so it
// reports the workload's access, not the caller's.
//
// Wait predicate: the pod is Running AND the current logs (get_logs
// previous=false) contain the Forbidden signal for secrets AND check_rbac reports
// allowed=false for the ServiceAccount on list/secrets. Requiring the log signal
// (not just the deterministic RBAC denial) is what makes the captured fixtures
// realistic: the forbidden line is present before fixtures are taken.
//
// GROUNDTRUTH NOTE (marker rule, see TEMPLATE.md step 2): after a real recapture,
// groundtruth.json expectedEvidence for this scenario is set from the real
// captured signals, namely the forbidden log line (the `cannot list resource
// "secrets"` phrasing get_logs records) and the check_rbac denial. Those markers
// are set from the actual capture, not fabricated here. The current markers
// ("log-shipper", "list", "secrets") are discriminating substrings that appear in
// both those real signals.

import { canonicalizeToolArgs } from "../../core/tools/canonicalizeToolArgs";
import type {
  CheckRbacOutput,
  GetLogsOutput,
  GetPodsOutput,
} from "../../core/tools";
import { findPodByPrefix, type CaptureSpec } from "../captureSpec";

// The permission the log-shipper workload needs and is denied. Echoed verbatim
// in the check_rbac fixture and named in the container's forbidden log line, so
// the expectedEvidence markers (the ServiceAccount, verb, and resource) literally
// appear.
const SERVICE_ACCOUNT = "log-shipper";
const VERB = "list";
const RESOURCE = "secrets";

export const captureSpec: CaptureSpec = {
  surface: {
    // buildReadSurface probes get_configmap and get_secret_meta for the
    // deployment name ("log-shipper") structurally, so neither is listed here.
    deployment: "log-shipper",
    rbac: { serviceAccount: SERVICE_ACCOUNT, verb: VERB, resource: RESOURCE },
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
      return { done: false, pod: "", detail: "workload pod not created yet" };
    }
    const running = pod.phase === "Running";

    // The container prints the Forbidden error to stdout, so read the current
    // logs (previous=false: it never crashes) and look for the denial signal for
    // secrets. A healthy workload, or one failing a different way, would not emit
    // it, so it discriminates. Match on both "forbidden" and "secrets" in one
    // line to stay robust to minor kubectl formatting.
    const logsResult = await provider.resolve({
      tool: "get_logs",
      args: canonicalizeToolArgs("get_logs", {
        namespace: scenario.namespace,
        pod: pod.name,
        previous: false,
      }),
    });
    const logsOutput = logsResult.output as GetLogsOutput;
    const lines = Array.isArray(logsOutput.lines) ? logsOutput.lines : [];
    const forbiddenInLogs = lines.some(
      (line) =>
        line.toLowerCase().includes("forbidden") && line.includes(RESOURCE),
    );

    const rbacResult = await provider.resolve({
      tool: "check_rbac",
      args: canonicalizeToolArgs("check_rbac", {
        namespace: scenario.namespace,
        serviceAccount: SERVICE_ACCOUNT,
        verb: VERB,
        resource: RESOURCE,
      }),
    });
    const denied = (rbacResult.output as CheckRbacOutput).allowed === false;

    const done = running && forbiddenInLogs && denied;
    return {
      done,
      pod: pod.name,
      detail:
        `pod ${pod.name} phase=${pod.phase} forbiddenInLogs=${forbiddenInLogs} ` +
        `${SERVICE_ACCOUNT} allowed(${VERB} ${RESOURCE})=${!denied}`,
    };
  },
};
