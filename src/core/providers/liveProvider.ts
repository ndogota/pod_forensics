// LiveProvider talks to a real cluster. Local development only.
//
// It never runs in production. The deployed demo and the eval harness use
// FixtureProvider instead. This is the read side of the capture path: it maps a
// Kubernetes API object to the exact tool output interface defined in
// src/core/tools, so the agent sees the same shape whether a call is served
// live or replayed from a fixture.
//
// Safety posture, unchanged: every call here is a read. Nothing mutates a
// workload. get_secret_meta returns the secret name and its key names only,
// never a value, so no secret value can reach a fixture or a trace.
//
// Identity note: check_rbac uses a SelfSubjectAccessReview, which answers "can
// the caller (the current kubeconfig identity) do this", not "can an arbitrary
// service account do this". The serviceAccount argument is echoed back for the
// record but does not change whose access is checked. A per-service-account
// check would need a SubjectAccessReview or impersonation, which is out of
// scope for the read-only local capture path.

import * as k8s from "@kubernetes/client-node";

import { toolInputSchemas, toolDefinitions } from "../tools";
import type {
  CheckRbacOutput,
  ContainerStateTerminated,
  ContainerStatusSummary,
  DescribeDeploymentOutput,
  DescribePodOutput,
  EventSummary,
  GetConfigmapOutput,
  GetEventsOutput,
  GetLogsOutput,
  GetPodsOutput,
  GetSecretMetaOutput,
  GetServiceEndpointsOutput,
  PodCondition,
  PodSummary,
  ServiceEndpointAddress,
} from "../tools";
import type {
  ToolCall,
  ToolDefinition,
  ToolProvider,
  ToolResult,
} from "../types";

// Map a Kubernetes API 404 to a clean boolean, rethrow anything else. The
// client throws an ApiException carrying a numeric HTTP code.
function isNotFound(err: unknown): boolean {
  return (err as { code?: number })?.code === 404;
}

function isoOrUndefined(d: Date | undefined): string | undefined {
  return d ? new Date(d).toISOString() : undefined;
}

// A compact age string like kubectl's, derived from a creation timestamp.
function ageString(creation: Date | undefined, now: Date): string {
  if (!creation) return "";
  const secs = Math.max(0, Math.floor((now.getTime() - new Date(creation).getTime()) / 1000));
  if (secs < 60) return `${secs}s`;
  const mins = Math.floor(secs / 60);
  if (mins < 60) return `${mins}m`;
  const hours = Math.floor(mins / 60);
  if (hours < 24) return `${hours}h`;
  return `${Math.floor(hours / 24)}d`;
}

function mapTerminated(
  t: k8s.V1ContainerStateTerminated | undefined,
): ContainerStateTerminated | undefined {
  if (!t) return undefined;
  return {
    exitCode: t.exitCode,
    reason: t.reason,
    startedAt: isoOrUndefined(t.startedAt),
    finishedAt: isoOrUndefined(t.finishedAt),
    message: t.message,
  };
}

function mapContainerStatuses(
  statuses: k8s.V1ContainerStatus[] | undefined,
): ContainerStatusSummary[] {
  if (!statuses) return [];
  return statuses.map((cs) => {
    let state: ContainerStatusSummary["state"] = "running";
    let reason: string | undefined;
    let message: string | undefined;
    let exitCode: number | undefined;
    if (cs.state?.waiting) {
      state = "waiting";
      reason = cs.state.waiting.reason;
      message = cs.state.waiting.message;
    } else if (cs.state?.terminated) {
      state = "terminated";
      reason = cs.state.terminated.reason;
      message = cs.state.terminated.message;
      exitCode = cs.state.terminated.exitCode;
    }
    return {
      name: cs.name,
      ready: cs.ready,
      restartCount: cs.restartCount,
      state,
      reason,
      message,
      exitCode,
      lastTerminated: mapTerminated(cs.lastState?.terminated),
    };
  });
}

function mapConditions(
  conditions: k8s.V1PodCondition[] | undefined,
): PodCondition[] {
  if (!conditions) return [];
  return conditions.map((c) => ({
    type: c.type,
    status: c.status as PodCondition["status"],
    reason: c.reason,
    message: c.message,
  }));
}

// Normalize a core/v1 Event into the shared EventSummary shape. The core events
// API carries the classic fields (message, count, firstTimestamp, lastTimestamp,
// involvedObject) that map one to one onto EventSummary.
function mapEvent(e: k8s.CoreV1Event): EventSummary {
  const kind = e.involvedObject?.kind ?? "";
  const name = e.involvedObject?.name ?? "";
  return {
    type: (e.type === "Warning" ? "Warning" : "Normal") as EventSummary["type"],
    reason: e.reason ?? "",
    message: e.message ?? "",
    count: e.count ?? 1,
    firstSeen: isoOrUndefined(e.firstTimestamp),
    lastSeen: isoOrUndefined(e.lastTimestamp ?? e.eventTime),
    involvedObject: `${kind}/${name}`,
  };
}

// Events for a namespace, optionally narrowed to one involved object name.
function mapEvents(list: k8s.CoreV1EventList, forName?: string): EventSummary[] {
  const items = list.items ?? [];
  const filtered = forName
    ? items.filter((e) => e.involvedObject?.name === forName)
    : items;
  return filtered.map(mapEvent);
}

export class LiveProvider implements ToolProvider {
  private readonly kc: k8s.KubeConfig;
  private readonly core: k8s.CoreV1Api;
  private readonly apps: k8s.AppsV1Api;
  private readonly authz: k8s.AuthorizationV1Api;

  // Reads kubeconfig from the environment (KUBECONFIG or ~/.kube/config). The
  // capture harness assumes the current context points at a reachable local
  // cluster.
  constructor(kc?: k8s.KubeConfig) {
    this.kc = kc ?? (() => {
      const c = new k8s.KubeConfig();
      c.loadFromDefault();
      return c;
    })();
    this.core = this.kc.makeApiClient(k8s.CoreV1Api);
    this.apps = this.kc.makeApiClient(k8s.AppsV1Api);
    this.authz = this.kc.makeApiClient(k8s.AuthorizationV1Api);
  }

  listTools(): ToolDefinition[] {
    return toolDefinitions;
  }

  async resolve(call: ToolCall): Promise<ToolResult> {
    if (!(call.tool in toolInputSchemas)) {
      throw new Error(`unknown tool: ${call.tool}`);
    }
    // A ToolCall carries normalized string args by contract, so booleans such as
    // get_logs previous arrive as "true"/"false". dispatch reads those strings
    // directly. Do not parse against the model-facing zod input schema here: it
    // types previous as a boolean and would reject the normalized string form.
    const output = await this.dispatch(call.tool, call.args);
    return { tool: call.tool, args: call.args, output };
  }

  private async dispatch(
    tool: string,
    args: Record<string, string>,
  ): Promise<unknown> {
    switch (tool) {
      case "get_pods":
        return this.getPods(args.namespace);
      case "describe_pod":
        return this.describePod(args.namespace, args.pod);
      case "get_events":
        return this.getEvents(args.namespace);
      case "get_logs":
        return this.getLogs(
          args.namespace,
          args.pod,
          args.container,
          args.previous === "true",
        );
      case "describe_deployment":
        return this.describeDeployment(args.namespace, args.deployment);
      case "get_service_endpoints":
        return this.getServiceEndpoints(args.namespace, args.service);
      case "get_configmap":
        return this.getConfigmap(args.namespace, args.name);
      case "get_secret_meta":
        return this.getSecretMeta(args.namespace, args.name);
      case "check_rbac":
        return this.checkRbac(
          args.namespace,
          args.serviceAccount,
          args.verb,
          args.resource,
        );
      default:
        throw new Error(`unhandled tool: ${tool}`);
    }
  }

  private async getPods(namespace: string): Promise<GetPodsOutput> {
    const list = await this.core.listNamespacedPod({ namespace });
    const now = new Date();
    const pods: PodSummary[] = (list.items ?? []).map((pod) => {
      const statuses = mapContainerStatuses(pod.status?.containerStatuses);
      const ready = `${statuses.filter((s) => s.ready).length}/${statuses.length}`;
      const restarts = statuses.reduce((sum, s) => sum + s.restartCount, 0);
      return {
        name: pod.metadata?.name ?? "",
        phase: pod.status?.phase ?? "Unknown",
        ready,
        restarts,
        age: ageString(pod.metadata?.creationTimestamp, now),
        node: pod.spec?.nodeName,
        containerStatuses: statuses,
      };
    });
    return { namespace, pods };
  }

  private async describePod(
    namespace: string,
    pod: string,
  ): Promise<DescribePodOutput> {
    const p = await this.core.readNamespacedPod({ name: pod, namespace });
    const events = await this.core.listNamespacedEvent({ namespace });
    return {
      namespace,
      name: p.metadata?.name ?? pod,
      phase: p.status?.phase ?? "Unknown",
      node: p.spec?.nodeName,
      labels: p.metadata?.labels ?? {},
      containers: mapContainerStatuses(p.status?.containerStatuses),
      conditions: mapConditions(p.status?.conditions),
      events: mapEvents(events, pod),
    };
  }

  private async getEvents(namespace: string): Promise<GetEventsOutput> {
    const list = await this.core.listNamespacedEvent({ namespace });
    return { namespace, events: mapEvents(list) };
  }

  private async getLogs(
    namespace: string,
    pod: string,
    container: string | undefined,
    previous: boolean,
  ): Promise<GetLogsOutput> {
    let text = "";
    try {
      text = await this.core.readNamespacedPodLog({
        name: pod,
        namespace,
        container,
        previous,
      });
    } catch (err) {
      // A pod that has not yet crashed has no previous instance to read. Treat a
      // missing previous log as empty rather than an error, so capture does not
      // depend on exact restart timing.
      if (!isNotFound(err)) throw err;
    }
    const lines = text.length > 0 ? text.replace(/\n$/, "").split("\n") : [];
    return {
      namespace,
      pod,
      container,
      previous,
      lines,
      truncated: false,
    };
  }

  private async describeDeployment(
    namespace: string,
    deployment: string,
  ): Promise<DescribeDeploymentOutput> {
    const d = await this.apps.readNamespacedDeployment({
      name: deployment,
      namespace,
    });
    const events = await this.core.listNamespacedEvent({ namespace });
    return {
      namespace,
      name: d.metadata?.name ?? deployment,
      desiredReplicas: d.spec?.replicas ?? 0,
      availableReplicas: d.status?.availableReplicas ?? 0,
      selector: d.spec?.selector?.matchLabels ?? {},
      conditions: (d.status?.conditions ?? []).map((c) => ({
        type: c.type,
        status: c.status as PodCondition["status"],
        reason: c.reason,
        message: c.message,
      })),
      events: mapEvents(events, deployment),
    };
  }

  private async getServiceEndpoints(
    namespace: string,
    service: string,
  ): Promise<GetServiceEndpointsOutput> {
    const svc = await this.core.readNamespacedService({
      name: service,
      namespace,
    });
    const selector = svc.spec?.selector ?? {};

    // The Endpoints object shares the service name. Absent endpoints (the
    // ServiceNoEndpoints signal) surface as a 404 or an empty subset list.
    let addresses: ServiceEndpointAddress[] = [];
    try {
      const ep = await this.core.readNamespacedEndpoints({
        name: service,
        namespace,
      });
      addresses = (ep.subsets ?? []).flatMap((subset) => [
        ...(subset.addresses ?? []).map((a) => ({
          ip: a.ip,
          targetPod: a.targetRef?.name,
          ready: true,
        })),
        ...(subset.notReadyAddresses ?? []).map((a) => ({
          ip: a.ip,
          targetPod: a.targetRef?.name,
          ready: false,
        })),
      ]);
    } catch (err) {
      if (!isNotFound(err)) throw err;
    }
    return { namespace, service, selector, addresses };
  }

  private async getConfigmap(
    namespace: string,
    name: string,
  ): Promise<GetConfigmapOutput> {
    try {
      const cm = await this.core.readNamespacedConfigMap({ name, namespace });
      return { namespace, name, exists: true, data: cm.data ?? {} };
    } catch (err) {
      if (isNotFound(err)) {
        return { namespace, name, exists: false, data: {} };
      }
      throw err;
    }
  }

  private async getSecretMeta(
    namespace: string,
    name: string,
  ): Promise<GetSecretMetaOutput> {
    try {
      const secret = await this.core.readNamespacedSecret({ name, namespace });
      // Key names only. The values in secret.data are never read or returned,
      // so no secret value can land in a fixture or a trace.
      return {
        namespace,
        name,
        exists: true,
        keys: Object.keys(secret.data ?? {}),
      };
    } catch (err) {
      if (isNotFound(err)) {
        return { namespace, name, exists: false, keys: [] };
      }
      throw err;
    }
  }

  private async checkRbac(
    namespace: string,
    serviceAccount: string,
    verb: string,
    resource: string,
  ): Promise<CheckRbacOutput> {
    const review = await this.authz.createSelfSubjectAccessReview({
      body: {
        spec: {
          resourceAttributes: { namespace, verb, resource },
        },
      },
    });
    return {
      namespace,
      serviceAccount,
      verb,
      resource,
      allowed: review.status?.allowed ?? false,
      reason: review.status?.reason,
    };
  }
}
