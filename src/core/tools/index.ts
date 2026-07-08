// Read-only tool set for pod_forensics.
//
// Definitions only. There is no execution logic here. A ToolProvider is the
// only thing that turns a ToolCall into data. Every tool is a read-only
// equivalent of a common kubectl read. Nothing here mutates a cluster.
//
// Each tool declares:
//   - a zod input schema (validates and documents the call arguments)
//   - a structured output interface (the shape a provider must return)
//   - a ToolDefinition entry whose inputSchema is JSON schema derived from zod
//
// Safety note: get_secret_meta returns existence and key names only, never
// secret values, so nothing sensitive can land in a fixture or a trace.
//
// TODO: the architecture document heading says "Eight tools" but the read-only
// tool set explicitly lists nine. All nine listed tools are defined here. The
// count wording should be reconciled in the document.

import { z } from "zod";
import type { ToolDefinition } from "../types";

// --- Shared output fragments ------------------------------------------------

// The prior terminated instance of a container. Present on a container that has
// restarted, which is the signal a crash loop leaves behind.
export interface ContainerStateTerminated {
  exitCode: number;
  reason?: string;    // e.g. Error, OOMKilled, Completed
  startedAt?: string;
  finishedAt?: string;
  message?: string;
}

// A single container state as surfaced by a pod read.
export interface ContainerStatusSummary {
  name: string;
  ready: boolean;
  restartCount: number;
  state: "running" | "waiting" | "terminated";
  reason?: string;    // current waiting/terminated reason, e.g. CrashLoopBackOff
  message?: string;
  exitCode?: number;  // set when the container is currently terminated
  lastTerminated?: ContainerStateTerminated; // prior instance, for crash loops
}

// A normalized Kubernetes event.
export interface EventSummary {
  type: "Normal" | "Warning";
  reason: string;
  message: string;
  count: number;
  firstSeen?: string;
  lastSeen?: string;
  involvedObject: string; // kind/name, e.g. Pod/web-7d9
}

// A pod condition, e.g. PodScheduled or Ready.
export interface PodCondition {
  type: string;
  status: "True" | "False" | "Unknown";
  reason?: string;
  message?: string;
}

// --- get_pods ---------------------------------------------------------------

export const getPodsInput = z.object({
  namespace: z.string(),
});

export interface PodSummary {
  name: string;
  phase: string;        // Pending, Running, Succeeded, Failed, Unknown
  ready: string;        // "0/1"
  restarts: number;
  age: string;
  node?: string;
  containerStatuses: ContainerStatusSummary[];
}

export interface GetPodsOutput {
  namespace: string;
  pods: PodSummary[];
}

// --- describe_pod -----------------------------------------------------------

export const describePodInput = z.object({
  namespace: z.string(),
  pod: z.string(),
});

export interface DescribePodOutput {
  namespace: string;
  name: string;
  phase: string;
  node?: string;
  labels: Record<string, string>;
  containers: ContainerStatusSummary[];
  conditions: PodCondition[];
  events: EventSummary[];
}

// --- get_events -------------------------------------------------------------

export const getEventsInput = z.object({
  namespace: z.string(),
});

export interface GetEventsOutput {
  namespace: string;
  events: EventSummary[];
}

// --- get_logs ---------------------------------------------------------------

export const getLogsInput = z.object({
  namespace: z.string(),
  pod: z.string(),
  container: z.string().optional(),
  // previous reads the logs of the prior crashed instance.
  // TODO: ToolCall.args is Record<string, string>, so this boolean is coerced
  // to/from a string at the agent boundary. Coercion is a later quest.
  previous: z.boolean().optional(),
});

export interface GetLogsOutput {
  namespace: string;
  pod: string;
  container?: string;
  previous: boolean;
  lines: string[];
  truncated: boolean;
}

// --- describe_deployment ----------------------------------------------------

export const describeDeploymentInput = z.object({
  namespace: z.string(),
  deployment: z.string(),
});

export interface DescribeDeploymentOutput {
  namespace: string;
  name: string;
  desiredReplicas: number;
  availableReplicas: number;
  selector: Record<string, string>;
  conditions: PodCondition[];
  events: EventSummary[];
}

// --- get_service_endpoints --------------------------------------------------

export const getServiceEndpointsInput = z.object({
  namespace: z.string(),
  service: z.string(),
});

export interface ServiceEndpointAddress {
  ip: string;
  targetPod?: string;
  ready: boolean;
}

export interface GetServiceEndpointsOutput {
  namespace: string;
  service: string;
  selector: Record<string, string>;
  addresses: ServiceEndpointAddress[];
}

// --- get_configmap ----------------------------------------------------------

export const getConfigmapInput = z.object({
  namespace: z.string(),
  name: z.string(),
});

export interface GetConfigmapOutput {
  namespace: string;
  name: string;
  exists: boolean;
  data: Record<string, string>;
}

// --- get_secret_meta --------------------------------------------------------

export const getSecretMetaInput = z.object({
  namespace: z.string(),
  name: z.string(),
});

// Existence and key names only. Values are never returned.
export interface GetSecretMetaOutput {
  namespace: string;
  name: string;
  exists: boolean;
  keys: string[]; // key names only, never values
}

// --- check_rbac -------------------------------------------------------------

export const checkRbacInput = z.object({
  namespace: z.string(),
  serviceAccount: z.string(),
  verb: z.string(),
  resource: z.string(),
});

export interface CheckRbacOutput {
  namespace: string;
  serviceAccount: string;
  verb: string;
  resource: string;
  allowed: boolean;
  reason?: string;
}

// --- Registry ---------------------------------------------------------------

// Internal record pairing a tool's zod input schema with its description.
interface ToolSpec {
  name: string;
  description: string;
  inputSchema: z.ZodType;
}

const SPECS: ToolSpec[] = [
  {
    name: "get_pods",
    description:
      "List pods in a namespace with phase, readiness, restart counts, and per-container status. Read only.",
    inputSchema: getPodsInput,
  },
  {
    name: "describe_pod",
    description:
      "Describe one pod: spec, labels, container states, conditions, and related events. Read only.",
    inputSchema: describePodInput,
  },
  {
    name: "get_events",
    description:
      "List normalized events for a namespace, including warnings such as scheduling and image pull failures. Read only.",
    inputSchema: getEventsInput,
  },
  {
    name: "get_logs",
    description:
      "Read logs for a pod container. Set previous to read the prior crashed instance. Read only.",
    inputSchema: getLogsInput,
  },
  {
    name: "describe_deployment",
    description:
      "Describe a deployment: desired and available replicas, selector, conditions, and events. Read only.",
    inputSchema: describeDeploymentInput,
  },
  {
    name: "get_service_endpoints",
    description:
      "List the endpoints backing a service and the selector it uses. Reveals selectors that match no pods. Read only.",
    inputSchema: getServiceEndpointsInput,
  },
  {
    name: "get_configmap",
    description:
      "Read a ConfigMap by name, reporting existence and its data keys and values. Read only.",
    inputSchema: getConfigmapInput,
  },
  {
    name: "get_secret_meta",
    description:
      "Report whether a Secret exists and list its key names only. Values are never returned. Read only.",
    inputSchema: getSecretMetaInput,
  },
  {
    name: "check_rbac",
    description:
      "Check whether a service account is allowed to perform a verb on a resource, " +
      "in the style of kubectl auth can-i. When a log line or event shows a " +
      'Kubernetes Forbidden error (for example: secrets is forbidden: User ' +
      '"system:serviceaccount:telemetry:log-shipper" cannot list resource "secrets"), ' +
      "call this using the exact verb, resource, and service account that error " +
      "names (there, verb=list, resource=secrets, serviceAccount=log-shipper) rather " +
      "than guessing combinations. Read only.",
    inputSchema: checkRbacInput,
  },
];

// zod input schema keyed by tool name. Providers and the agent boundary can use
// this to validate ToolCall arguments before resolving.
export const toolInputSchemas: Record<string, z.ZodType> = Object.fromEntries(
  SPECS.map((s) => [s.name, s.inputSchema]),
);

// ToolDefinition entries, with inputSchema as JSON schema derived from zod.
export const toolDefinitions: ToolDefinition[] = SPECS.map((s) => ({
  name: s.name,
  description: s.description,
  inputSchema: z.toJSONSchema(s.inputSchema),
}));

export const toolNames: string[] = SPECS.map((s) => s.name);
