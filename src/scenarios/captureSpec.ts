// The per-scenario capture contract.
//
// Each scenario declares HOW its failure manifests (the wait predicate) and
// WHAT named objects live in its read surface (the CaptureSurface metadata). This
// lives beside the scenario data, not on the frozen Scenario type in core/types,
// so scenario identity stays untouched.
//
// A scenario no longer hand-authors a minimal list of ToolCalls. Instead it
// declares its read surface as metadata, and the shared buildReadSurface routine
// expands that into the full set of read-only calls an exploring agent may touch.
// The agent chooses tools freely and diagnoses by ruling causes out, so replay
// must be robust to more than the smoking gun: negative and empty reads (a
// ConfigMap that does not exist, a Service that has endpoints, no RBAC denial)
// are recorded too.
//
// The capture harness (scripts/capture.ts) owns the polling loop: the timeout,
// the exponential backoff, and the progress logging are shared across all
// scenarios. Each scenario only supplies a `poll` predicate that inspects the
// live cluster through read-only tools and reports whether its failure has
// manifested yet. This keeps capture read-only and model-free: `poll` may only
// call ToolProvider.resolve, which resolves to reads.

import { canonicalizeToolArgs } from "../core/tools/canonicalizeToolArgs";
import type { Scenario, ToolCall, ToolProvider } from "../core/types";

// Everything a scenario's wait predicate needs for one poll attempt. elapsedMs
// is provided so a predicate can express a "past a grace period" condition
// without reading the clock itself (the harness owns the clock).
export interface PollContext {
  provider: ToolProvider;
  scenario: Scenario;
  elapsedMs: number;
}

// The outcome of one poll attempt.
export interface PollResult {
  // True once the scenario's failure has manifested and fixtures can be taken.
  done: boolean;
  // The resolved pod name for the captureSet. A Deployment names its pods with a
  // template hash suffix not known until the pod exists, so the predicate
  // resolves it live. Empty string when the captureSet needs no pod name.
  pod: string;
  // A one-line human-readable progress string the harness logs each attempt.
  detail: string;
}

// The named objects that make up a scenario's read surface beyond the calls the
// harness derives on its own (get_pods, get_events, and per-pod reads). The
// shared buildReadSurface routine turns this metadata into ToolCalls. Every field
// is optional: a scenario declares only what it has.
export interface CaptureSurface {
  // The workload Deployment, for describe_deployment. Typically the scenario
  // target name when the target is a Deployment.
  deployment?: string;
  // A Service the scenario defines, for get_service_endpoints. Omit when the
  // scenario has no Service.
  service?: string;
  // Extra ConfigMap names to probe with get_configmap, beyond the deployment name
  // (which buildReadSurface always probes on its own; see below). A name that does
  // not exist is recorded as a real not-found result on purpose: an exploring agent
  // probes for a ConfigMap to rule MissingConfigOrSecret in or out, and the
  // negative is the signal that lets it. List a name here only when it is not the
  // workload name, e.g. a ConfigMap a volume references by a distinct name.
  configmaps?: string[];
  // Extra Secret names to probe with get_secret_meta (existence and key names only,
  // never values), beyond the deployment name. Same not-found-is-wanted rationale
  // as configmaps.
  secrets?: string[];
  // An RBAC permission to check for the scenario's ServiceAccount, for
  // check_rbac. Omit when the scenario has no RBAC dimension.
  rbac?: { serviceAccount: string; verb: string; resource: string };
}

export interface CaptureSpec {
  // Wait predicate. Called once per poll attempt by the harness. It may only
  // issue read-only tool calls through ctx.provider.
  poll(ctx: PollContext): Promise<PollResult>;
  // Declarative read surface. The harness resolves pod names live from get_pods
  // and expands this metadata into the full ToolCall set via buildReadSurface.
  surface: CaptureSurface;
}

// Build the full read-only surface to record as fixtures for a scenario. Given
// the namespace, the scenario's declared surface, and the pod names resolved live
// from get_pods, it returns every ToolCall the harness records. It is exhaustive
// by design so replay is robust to the agent's free tool choice, and it records
// negative and empty reads too (per-pod logs that may be empty, a probed
// ConfigMap or Secret that does not exist), not only the smoking gun. Every
// call's args go through the shared canonicalizeToolArgs, so a recorded fixture
// key matches exactly what the agent hashes at replay.
//
// The deployment name is always probed with both get_configmap and get_secret_meta
// on top of the scenario's declared configmaps/secrets, deduplicated. The
// deployment name is the name an exploring agent most often infers when it reaches
// for a ConfigMap or Secret, so capturing it for every scenario turns that common
// inferred probe into a real captured result (exists where it exists, a real
// not-found where it does not) instead of a coverage MISS. This is structural: a
// new scenario inherits it without its author having to remember. It pairs with
// the FixtureProvider's deterministic not-found, which covers the rest of the
// unbounded name space (pod-hash suffixes and other inferred names) at replay.
export function buildReadSurface(
  namespace: string,
  surface: CaptureSurface,
  pods: string[],
): ToolCall[] {
  const calls: ToolCall[] = [
    { tool: "get_pods", args: canonicalizeToolArgs("get_pods", { namespace }) },
    {
      tool: "get_events",
      args: canonicalizeToolArgs("get_events", { namespace }),
    },
  ];

  // Per pod: describe it, and read both log streams. A crash loop leaves its
  // evidence in the previous (terminated) instance; the current stream is read
  // too because an agent that does not yet know a pod crashed calls get_logs
  // without previous, and both variants must resolve on replay.
  for (const pod of pods) {
    calls.push({
      tool: "describe_pod",
      args: canonicalizeToolArgs("describe_pod", { namespace, pod }),
    });
    calls.push({
      tool: "get_logs",
      args: canonicalizeToolArgs("get_logs", { namespace, pod, previous: true }),
    });
    calls.push({
      tool: "get_logs",
      args: canonicalizeToolArgs("get_logs", {
        namespace,
        pod,
        previous: false,
      }),
    });
  }

  if (surface.deployment) {
    calls.push({
      tool: "describe_deployment",
      args: canonicalizeToolArgs("describe_deployment", {
        namespace,
        deployment: surface.deployment,
      }),
    });
  }
  if (surface.service) {
    calls.push({
      tool: "get_service_endpoints",
      args: canonicalizeToolArgs("get_service_endpoints", {
        namespace,
        service: surface.service,
      }),
    });
  }
  // Probe the deployment name too, deduplicated against the declared names, so the
  // most common inferred probe is always captured. dedupe preserves order and drops
  // repeats and empties.
  const dedupe = (names: string[]): string[] => {
    const seen = new Set<string>();
    const out: string[] = [];
    for (const n of names) {
      if (n && !seen.has(n)) {
        seen.add(n);
        out.push(n);
      }
    }
    return out;
  };
  const withDeployment = (declared: string[] | undefined): string[] =>
    dedupe([...(declared ?? []), ...(surface.deployment ? [surface.deployment] : [])]);

  for (const name of withDeployment(surface.configmaps)) {
    calls.push({
      tool: "get_configmap",
      args: canonicalizeToolArgs("get_configmap", { namespace, name }),
    });
  }
  for (const name of withDeployment(surface.secrets)) {
    calls.push({
      tool: "get_secret_meta",
      args: canonicalizeToolArgs("get_secret_meta", { namespace, name }),
    });
  }
  if (surface.rbac) {
    const { serviceAccount, verb, resource } = surface.rbac;
    calls.push({
      tool: "check_rbac",
      args: canonicalizeToolArgs("check_rbac", {
        namespace,
        serviceAccount,
        verb,
        resource,
      }),
    });
  }

  return calls;
}

// Find the pod created by a workload. A Deployment names its pods with a
// template hash suffix, so match on the workload name prefix. Shared by the
// scenario predicates.
export function findPodByPrefix<T extends { name: string }>(
  pods: T[],
  workloadName: string,
): T | undefined {
  return pods.find((p) => p.name.startsWith(`${workloadName}-`));
}
