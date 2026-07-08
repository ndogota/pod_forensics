// Frozen contracts for pod_forensics.
//
// These types are the skeleton. Everything binds to them, so they are defined
// first and treated as frozen. Keep this file in sync with the Contracts section
// of the architecture document. Do not change a shape here without changing the
// document first.

// The closed failure set that makes evals possible.
export type FailureClass =
  | "CrashLoopBackOff"
  | "ImagePullBackOff"
  | "OOMKilled"
  | "ProbeMisconfigured"
  | "PodUnschedulable"
  | "ServiceNoEndpoints"
  | "MissingConfigOrSecret"
  | "RbacDenied";

export interface ToolCall {
  tool: string;
  args: Record<string, string>;
}

export interface ToolResult {
  tool: string;
  args: Record<string, string>;
  output: unknown;        // structured tool output
  capturedAt?: string;    // present when served from a fixture
}

export interface ToolDefinition {
  name: string;
  description: string;    // shown to the model
  inputSchema: object;    // JSON schema derived from a zod schema
}

export interface ToolProvider {
  listTools(): ToolDefinition[];
  resolve(call: ToolCall): Promise<ToolResult>;
}

export interface GroundTruth {
  failureClass: FailureClass;
  rootCause: string;          // canonical human description
  expectedEvidence: string[]; // signals the diagnosis should cite
}

export type DifficultyTier = "obvious" | "misleading";

export interface Scenario {
  id: string;
  description: string;
  // namespace and target were added because scenario identity includes the
  // namespace under diagnosis and the workload that fails.
  namespace: string;
  target: { kind: "Deployment" | "Pod" | "Service"; name: string };
  manifestsPath: string;      // broken k8s YAML
  groundTruth: GroundTruth;
  tier: DifficultyTier;
}

export interface Evidence {
  tool: string;
  args: Record<string, string>;
  excerpt: string;            // the specific signal cited
}

export interface Diagnosis {
  failureClass: FailureClass;
  rootCause: string;
  evidence: Evidence[];
  suggestedFix: string;
  confidence: number;         // 0..1
}

export interface TraceStep {
  index: number;
  toolCall: ToolCall;
  latencyMs: number;
  tokensIn: number;
  tokensOut: number;
}

export interface RunTrace {
  scenarioId: string;
  steps: TraceStep[];
  diagnosis: Diagnosis;
  stepCount: number;
  totalTokens: number;
  // Usage split, summed across turns. tokensIn is the uncached input remainder,
  // tokensOut the generated output, and cacheReadTokens the tokens served from
  // the prompt cache. Kept separate from totalTokens so the eval can price a run
  // (input, output, and cache reads bill at different rates).
  tokensIn: number;
  tokensOut: number;
  cacheReadTokens: number;
  costUsd: number;
  totalLatencyMs: number;
}

export interface ScenarioScore {
  scenarioId: string;
  tier: DifficultyTier;
  runs: number;                // runs attempted
  completionRate: number;      // fraction of attempted runs that produced a valid diagnosis
  classAccuracy: number;       // fraction of runs with correct failureClass
  evidenceRecall: number;      // fraction of expectedEvidence cited
  rootCauseJudgeScore: number; // 0..1 from the LLM-as-judge rubric
}

export interface RunReport {
  createdAt: string;
  model: string;
  scenarioScores: ScenarioScore[];
  confusionMatrix: Record<string, Record<string, number>>;
  traces: RunTrace[];
}
