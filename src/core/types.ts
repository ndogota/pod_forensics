// Frozen contracts for pod_forensics.
//
// These types are the skeleton. Everything binds to them, so they are defined
// first and treated as frozen. Keep this file in sync with the Contracts section
// of the architecture document. Do not change a shape here without changing the
// document first.

// The taxonomy has two orthogonal axes, scored independently: the observable
// symptom (what the pod or service looks like) and the root-cause class (why).
// One symptom can arise from several causes and one cause can surface as several
// symptoms, so a diagnosis names both and each is graded on its own.

// The observable pod or service state.
export type Symptom =
  | "CrashLoopBackOff"
  | "ImagePullBackOff"
  | "OOMKilled"
  | "Pending"
  | "RunningDegraded"
  | "ServiceNoEndpoints";

// The underlying cause. May differ from the symptom.
export type RootCauseClass =
  | "BadCommand"
  | "MissingConfigOrSecret"
  | "ImageUnavailable"
  | "InsufficientResources"
  | "MemoryLimitExceeded"
  | "ProbeMisconfigured"
  | "SelectorLabelMismatch"
  | "RbacDenied";

/**
 * @deprecated The single-axis failure taxonomy was split into the orthogonal
 * {@link Symptom} and {@link RootCauseClass}. Kept only as an alias for any
 * straggling importer; all first-party usages have migrated.
 */
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
  symptom: Symptom;              // the observable pod or service state
  rootCauseClass: RootCauseClass; // the underlying cause; may differ from the symptom
  rootCause: string;            // canonical human description
  expectedEvidence: string[];   // signals the diagnosis should cite
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
  // Scalars first, evidence last: the two orthogonal axes are scored
  // independently, and keeping the bulky evidence array trailing means a turn
  // truncated by max_tokens drops evidence before these small scalars.
  symptom: Symptom;              // the observable pod or service state
  rootCauseClass: RootCauseClass; // the underlying cause; may differ from the symptom
  rootCause: string;
  suggestedFix: string;
  confidence: number;         // 0..1
  evidence: Evidence[];
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
  symptomAccuracy: number;     // fraction of runs with correct symptom
  causeAccuracy: number;       // fraction of runs with correct rootCauseClass
  evidenceRecall: number;      // fraction of expectedEvidence cited
  rootCauseJudgeScore: number; // 0..1 from the LLM-as-judge rubric
}

export interface RunReport {
  createdAt: string;
  model: string;
  scenarioScores: ScenarioScore[];
  // Keyed on RootCauseClass (actual -> predicted -> count): the cause is the
  // interesting axis, where an agent that pattern-matches a surface symptom goes
  // wrong.
  confusionMatrix: Record<string, Record<string, number>>;
  traces: RunTrace[];
}
