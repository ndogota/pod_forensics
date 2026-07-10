# pod_forensics

Agentic root cause analysis for Kubernetes failures, with a reproducible eval harness.

Given a failing workload, an agent runs read-only diagnostic tools, forms a root-cause hypothesis in a reasoning loop, and emits a structured diagnosis. Every diagnosis is scored against known ground truth across a fixed set of seeded failures. The whole system runs against captured fixtures, so it is reproducible and costs nothing to host.

This document is the architecture source of truth. Code, structure, and the README narrative all follow from it.

## What this is and is not

This is a controlled demonstration of an agentic diagnosis loop and an eval methodology over a finite, known failure taxonomy. It is not a production SRE tool, and the README must say so plainly. Tools like k8sgpt already occupy the production space. That is a signal the problem is real and valued, not a reason to dress this up as a novel product. The honest framing is the point: the value on show is the reasoning loop, the eval rigor, and the systems hygiene, not the breadth of coverage.

## Scope guardrails

These are hard limits for v1. They exist to keep the project finishable in roughly two weeks and to keep the engineering honest.

- Read only. No mutation, no remediation, no apply or patch. Diagnosis only.
- Finite taxonomy. Ten seeded scenarios, no more.
- No multi-cluster, no continuous monitoring, no real-time streaming.
- Single namespace per diagnosis run.
- Secrets are never read by value. The secret tool returns existence and key names only, never values, so nothing sensitive lands in fixtures or traces.

## Architecture

One load-bearing decision drives everything: the agent never talks to Kubernetes directly. It talks to a `ToolProvider` interface that resolves tool calls to data. There are two implementations of that interface, and the agent cannot tell them apart.

- `FixtureProvider` reads captured JSON. Used in eval and in the deployed demo.
- `LiveProvider` talks to a real cluster. Used in local development only.

This seam is what makes the eval reproducible (inputs are frozen), the demo free to host (no live cluster in production), and the data collection cleanly separated from the agent logic.

### Three temporal phases

The system is best understood as three moments that do not run at the same time or in the same place.

1. Capture (offline, local). Seed a failure scenario on a local kind cluster, run every read-only tool against it, serialize the outputs to JSON fixtures, and commit the fixtures plus the ground truth. This never runs in production.
2. Runtime (the agent). The agent receives tool access through the `ToolProvider` and iterates: observe, hypothesize, fetch the evidence that confirms or refutes, conclude. It emits a structured `Diagnosis` and a stream of trace events.
3. Eval (CI or local). The runner executes the agent against each scenario N times against fixtures, scores each diagnosis against ground truth, records the traces, and writes run reports.

Serving is static: the dashboard reads committed run reports and traces. No cluster, no idle cost.

## Modules

Each module has one responsibility and knows nothing of another beyond its contract.

- `scenarios` holds data as code: broken manifests, the ground-truth label, and a difficulty tier per failure.
- `tools` defines the read-only tools with typed input and output schemas. Definitions only, no execution logic.
- `providers` implements `ToolProvider`: `FixtureProvider` and `LiveProvider`. The only place that knows where data comes from.
- `capture` is the offline harness: seed, run tools, serialize to fixtures. Local only.
- `agent` is the reasoning loop and nothing else. It depends on the `ToolProvider` interface, never on a concrete implementation. It emits a `Diagnosis` and trace events.
- `eval` orchestrates runs, scores against ground truth, aggregates, and writes reports.
- `dashboard` is pure presentation. It reads reports and traces and holds no domain logic.

## Contracts

These types are the skeleton. They are graved first because everything binds to them. Implementation language is TypeScript.

The taxonomy has two orthogonal axes, scored independently: the observable
symptom and the underlying root cause. A single symptom can arise from several
causes, so a diagnosis names both and each is graded on its own. (Amendment: the
original design had a single `FailureClass` axis; a real run showed it conflated
what is observed with why, so it was split. `FailureClass` remains exported only
as a deprecated alias.)

```ts
// The observable pod or service state.
export type Symptom =
  | "CrashLoopBackOff"
  | "ImagePullBackOff"
  | "OOMKilled"
  | "Pending"
  | "RunningDegraded"
  | "ServiceNoEndpoints";

// The underlying cause; may differ from the symptom.
export type RootCauseClass =
  | "BadCommand"
  | "MissingConfigOrSecret"
  | "ImageUnavailable"
  | "InsufficientResources"
  | "MemoryLimitExceeded"
  | "ProbeMisconfigured"
  | "SelectorLabelMismatch"
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
  symptom: Symptom;               // the observable pod or service state
  rootCauseClass: RootCauseClass; // the underlying cause; may differ from the symptom
  rootCause: string;              // canonical human description
  expectedEvidence: string[];     // signals the diagnosis should cite
}

export type DifficultyTier = "obvious" | "misleading";

export interface Scenario {
  id: string;
  description: string;
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
  // Scalars first, evidence last, so a max_tokens-truncated turn drops the bulky
  // evidence array before these small trailing scalars.
  symptom: Symptom;               // the observable pod or service state
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
  tokensIn: number;         // uncached input tokens, summed across turns
  tokensOut: number;        // output tokens, summed across turns
  cacheReadTokens: number;  // tokens served from the prompt cache
  costUsd: number;
  totalLatencyMs: number;
}

export interface ScenarioScore {
  scenarioId: string;
  tier: DifficultyTier;
  runs: number;
  completionRate: number;      // fraction of attempted runs that produced a valid diagnosis
  symptomAccuracy: number;     // fraction of runs with correct symptom
  causeAccuracy: number;       // fraction of runs with correct rootCauseClass
  evidenceRecall: number;      // fraction of expectedEvidence cited
  rootCauseJudgeScore: number; // 0..1 from the LLM-as-judge rubric
}

// Per-tier rollup of the scenarioScores. Each metric is the mean over that
// tier's scenarios.
export interface TierSummary {
  tier: DifficultyTier;
  scenarioCount: number;
  completionRate: number;
  symptomAccuracy: number;
  causeAccuracy: number;
  evidenceRecall: number;
  rootCauseJudge: number; // mean of ScenarioScore.rootCauseJudgeScore
}

export interface ByTierSummary {
  tiers: TierSummary[]; // one per tier present, obvious before misleading
  // obvious causeAccuracy minus misleading causeAccuracy; null unless both
  // tiers are present. The eval's headline number.
  causeAccuracyGap: number | null;
}

export interface RunReport {
  createdAt: string;
  model: string;
  scenarioScores: ScenarioScore[];
  byTier: ByTierSummary; // derived from scenarioScores; the tier rollup and gap
  confusionMatrix: Record<string, Record<string, number>>; // keyed on RootCauseClass
  traces: RunTrace[];
}
```

## Read-only tool set

Eight tools, all read only. Equivalents of common kubectl reads.

- `get_pods(namespace)`
- `describe_pod(namespace, pod)`
- `get_events(namespace)`
- `get_logs(namespace, pod, container?, previous?)`
- `describe_deployment(namespace, deployment)`
- `get_service_endpoints(namespace, service)`
- `get_configmap(namespace, name)`
- `get_secret_meta(namespace, name)` returns existence and key names only, never values
- `check_rbac(namespace, serviceAccount, verb, resource)` a can-i style permission check

## Scenarios

Ten seeded scenarios. Eight at the obvious tier, one per failure class. Two at the misleading tier, where the obvious surface signal is a symptom of a different root cause. The misleading scenarios are the point of the eval: they measure whether the agent reasons or just pattern matches on a string it sees in a tool output.

(Amendment: scenario 1 below, the seeded crashloopbackoff-bad-command, was briefly reclassified to the misleading tier on the theory that its "missing --config" log line is a decoy toward MissingConfigOrSecret while the true cause is BadCommand. An 8-run measurement retired that theory: the agent scores causeAccuracy 1.00 on it, so it reasons past the log string rather than grep-matching it. It is an honest obvious case and has been returned to the obvious tier. The genuine trap that replaced it is scenario configmap-volume-missing (see below): a pod stuck not-running with a volume mount that references a ConfigMap which does not exist, symptom Pending, true cause MissingConfigOrSecret. The seeded set currently carries four obvious scenarios and one misleading, not the eight-and-two split the full taxonomy below describes.)

Obvious tier, one each:

1. CrashLoopBackOff from a bad container command.
2. ImagePullBackOff from a wrong image tag.
3. OOMKilled from a memory limit set too low.
4. ProbeMisconfigured from a readiness probe pointing at the wrong port.
5. PodUnschedulable from a resource request no node can satisfy.
6. ServiceNoEndpoints from a selector that does not match pod labels.
7. MissingConfigOrSecret from a volume referencing a ConfigMap that does not exist.
8. RbacDenied from a ServiceAccount lacking the required role.

Misleading tier:

9. A pod in CrashLoopBackOff whose true cause is a missing ConfigMap consumed at startup. The crash is the symptom; the class is MissingConfigOrSecret. An agent that grep matches on CrashLoop fails this one.
10. A service with no endpoints whose true cause is that the backing pods are all unschedulable. The class is PodUnschedulable, not ServiceNoEndpoints.

## Locked design decisions

These were chosen deliberately and should each be defensible in an interview.

- Read only first. A diagnostic tool that cannot break anything is one you let run. It also bounds the scope.
- Capture and replay to fixtures. This is the most senior decision in the project. It buys reproducible evals, a free-to-host demo, and a clean separation of data collection from agent logic.
- Agentic loop over a fixed script. An if-else tree could classify these failures, but then the project demonstrates no AI engineering. The point is to show an agent navigating evidence the way an SRE would, choosing the next tool, avoiding redundant calls, and converging.
- Mandatory evidence citation. Every claim in a diagnosis must point at the tool output that supports it. This forces grounding, reduces hallucination, and makes the output auditable.
- Ground-truth evals. A seeded failure has a known answer, so scoring is automated and regressions are detectable. This is exactly what a thin API wrapper lacks.
- Hybrid scoring. Symptom and root-cause class are each scored by exact match on their own axis, evidence by key overlap, root-cause prose by an LLM-as-judge rubric. The use of a model inside scoring introduces non-determinism into the eval itself, which is a known soft spot and is stated as such in the README.
- Free tool choice bounded by a max step count. The free choice is the skill on display. A fixed plan walks back toward the if-else tree.

## Observability

Each run produces a `RunTrace` with the tool call sequence, tokens in and out, cost, latency, step count to diagnosis, and correctness against ground truth. The dashboard surfaces per-run traces, an eval summary with symptom accuracy, cause accuracy, and evidence recall per scenario and per tier, and a confusion matrix over root-cause classes.

## Deployment model

Eval runs are precomputed in CI and committed under `reports`. The dashboard reads them statically, so the deployed app needs no cluster and costs nothing at idle. An optional run-it-yourself interactive mode can run the agent against committed fixtures on demand, server side, behind a rate limit. The committed eval artifact is the proof; the interactive mode is a bonus.

## Definition of done for v1

- Ten scenarios seeded and captured to fixtures.
- Agent produces a structured `Diagnosis` per scenario.
- Eval suite scores all ten against ground truth across N runs and writes a `RunReport`.
- Dashboard deployed, reading committed reports and traces.
- README that explains the decisions above and the honest framing.
- Live clickable demo.

## Known limits to state honestly

A good evaluator will see these, so the README names them first.

- LLM non-determinism means evals are run N times and reported as a success rate, never a single pass or fail.
- The taxonomy is finite and clean. Real incidents are messier, multi-cause, and ambiguous. This is a controlled demonstration, not a production tool.
- An agent can cheat by reading a literal failure string from a tool output. The misleading-tier scenarios exist to measure exactly that, and the gap between obvious-tier and misleading-tier accuracy is the most interesting number the eval produces.

## README narrative guidance

The repo is a storefront. Foreground, in order: the eval methodology, the capture and replay seam, and the read-only safety posture. Frame it as built from scratch to demonstrate the agentic loop and the eval method, not as a novel product. Present it as an experimental tool. No school or course references, no years, no author handle, no before and after bug narration. Plain direct English. No em dashes. Include a concise safety and engineering note where relevant, including the secret-metadata-only decision.

## Suggested repository layout

```
pod_forensics/
  src/
    core/
      types.ts
      tools/
        index.ts
      providers/
        toolProvider.ts
        fixtureProvider.ts
        liveProvider.ts
      agent/
        loop.ts
        prompts.ts
        modelClient.ts
      eval/
        runner.ts
        scorer.ts
    scenarios/
      <scenario-id>/
        manifests.yaml
        groundtruth.json
    fixtures/
      <scenario-id>/
        <tool>-<argshash>.json
    app/
  scripts/
    capture.ts
    eval.ts
  reports/
  README.md
```
