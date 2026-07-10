# pod_forensics

An agent that diagnoses real captured Kubernetes failures. It is handed a broken
workload and a set of read-only diagnostic tools, then reasons in a loop (observe,
hypothesize, fetch the evidence that confirms or refutes, conclude) and emits a
structured diagnosis. Every diagnosis is scored by an eval harness on two
independent axes, the observable symptom and the underlying root cause, across
three models and five scenarios.

This is an experimental engineering project. The point on show is the eval
methodology, the capture-and-replay seam, and the read-only safety posture, not
breadth of failure coverage. Production tools already occupy the diagnosis space,
which is a sign the problem is real, not a reason to present this as a product.

Live dashboard: https://pod-forensics.vercel.app. It is a static read of the
committed eval artifacts, so it runs no cluster and needs no API key.

## Capture and replay

One decision drives the whole system: the agent never talks to Kubernetes
directly. It depends on a `ToolProvider` interface that resolves tool calls to
data, and it cannot tell which implementation is behind it.

- `FixtureProvider` reads captured JSON from `src/fixtures/<scenarioId>/`. Used in
  the eval and in the deployed dashboard.
- `LiveProvider` runs the read-only kubectl equivalents against a real cluster.
  Used only at capture time, on a local machine.

The fixtures are captured from real kind clusters, not authored by hand. The
capture harness seeds a broken manifest, waits for the failure to actually
manifest, then runs every read-only tool through `LiveProvider` and serializes
the real outputs. So the agent is tested against genuine kubectl output, decode
paths and all, not against data shaped to make it look good.

That seam buys three things:

- Reproducible evals. The inputs are frozen JSON, so a run is deterministic up to
  the model's own sampling, and a regression is a real regression.
- Zero-cost hosting. The dashboard is a static read of committed artifacts. No
  live cluster runs in production, and no API key is needed at runtime.
- Clean separation. Data collection lives entirely in the capture step. The agent
  and the eval know nothing about where the data came from.

Read-only is a hard property, not a convention. There is no mutation, no
remediation, no apply or patch anywhere in the tool set. The secret tool returns
existence and key names only, never values, so nothing sensitive lands in a
fixture or a trace.

## Why the eval is trustworthy

A single passing run proves nothing. The harness is built so that each number it
reports is defensible.

**Two independent axes.** Symptom and root cause are scored separately, each by
exact match against ground truth (`symptomAccuracy`, `causeAccuracy`). A symptom
can arise from more than one cause, so a run can name the symptom correctly and
still miss the cause. Two secondary signals ride alongside: `evidenceRecall`, the
fraction of expected evidence markers the diagnosis actually cites, and an
LLM-as-judge rubric scoring the free-text root-cause prose.

**Ground truth from real signals, never reverse-fitted.** Each scenario's
`groundtruth.json` is written from the real captured failure, not adjusted to
match what the agent happens to say. The `crashloopbackoff-bad-command` ground
truth records the misleading `missing required flag --config` log line as a
present-but-non-decisive signal, and the true cause stays `BadCommand`. When
measurement contradicted a hypothesis, the hypothesis was retired; the ground
truth was not bent to fit the agent.

**Failed runs are scored, never dropped.** A run that produces no valid diagnosis
is recorded as a `RunOutcome` of status `failed`. It scores zero on every
dimension and lowers `completionRate`, the fraction of attempted runs that
produced a valid diagnosis. Averages divide by attempts, not by successes, so a
model cannot look good by failing quietly.

**Determinism where it should be deterministic.** The committed single-model
reference report is produced by a scripted `FakeModelClient`, so it is
cluster-free, key-free, and stable. On top of that, `pnpm test:self-correction`
is a deterministic regression guard: a scripted client submits an invalid
diagnosis first (missing `confidence` and `suggestedFix`), and the test asserts
that the loop surfaces the validation error back to the model, that the model
resubmits, that the run completes, and that a self-corrected run scores identically
to a clean one-shot run. No API key, no cluster.

**N runs per cell with confidence intervals.** Every cell in the committed matrix
is 10 runs. `completionRate`, `symptomAccuracy`, `causeAccuracy`, and
`evidenceRecall` each carry a Wilson score 95% confidence interval over those
runs. Wilson is chosen deliberately: at low N and extreme proportions it never
runs off the ends of `[0, 1]`, and at a perfect 10 out of 10 it returns an
asymmetric interval, `[0.72, 1.00]`, not `[1.00, 1.00]`. Ten clean runs are still
consistent with a true rate below one, and the interval says so. The judge score
is a mean of continuous scores rather than a proportion of runs, so it reports a
standard deviation instead of a Wilson interval.

**Replay robust to free tool choice.** The agent chooses its own tools and
arguments, so it calls `get_logs` with or without `previous`, with or without an
explicit container. A single argument-canonicalization function shapes every call
into one canonical key, and both the capture (write) side and the fixture (read)
side run through it, so replay finds the file capture wrote regardless of which
variant the agent picked.

**Absence is a real answer.** The name-lookup tools `get_configmap` and
`get_secret_meta` answer an existence question over an unbounded name space. An
exploring agent probes them with inferred names to rule a missing config or secret
in or out, and most inferred names were never captured because they never existed.
A miss on one of those returns the exact structured not-found that `LiveProvider`
produces for a genuinely absent resource (`exists: false`), logged distinctly as
`NOTFOUND` rather than as a coverage gap. So the agent can use absence to
eliminate a cause, and a wrong name never derails the run.

## What the measurement found

The committed `reports/model-matrix.json` is three models across five scenarios at
10 runs each, 150 agent runs, judged by Haiku.

Four of the five scenarios are saturated: `pod-unschedulable`,
`service-no-endpoints`, `rbac-denied`, and `configmap-volume-missing` all score
`causeAccuracy` 1.00 for all three models. Even there the Wilson interval is
`[0.72, 1.00]`, a reminder that 10 for 10 is not proof of a perfect rate.

The one genuinely hard case is `crashloopbackoff-bad-command`. An application log
line names a missing `--config` flag, which reads like a decoy toward a missing
config or secret, while the true cause is a bad container command. Cause accuracy
there scales with model size:

| model  | causeAccuracy | Wilson 95% CI  |
| ------ | ------------- | -------------- |
| Haiku  | 0.40          | [0.17, 0.69]   |
| Sonnet | 0.60          | [0.31, 0.83]   |
| Opus   | 0.90          | [0.60, 0.98]   |

This is the single place in the matrix where model scale moves the result. The
harness localizes it precisely: everywhere else the models are indistinguishable.

The `completionRate` metric earned its place on this same case. One of the ten
Opus runs failed: the model leaked tool-call syntax into a diagnosis field value,
the validation-and-correction loop rejected the submit, and it was counted as a
failed run (Opus `completionRate` 0.90 on that cell, and its symptom and cause
accuracy each 0.90 as a result). It was scored as a miss, not silently discarded,
which is exactly what the metric and the correction loop exist to do.

## What the harness corrected

The eval's job is to correct the author's hypotheses, and it did.

The scenarios were first grouped by assumed difficulty into an `obvious` tier and
a `misleading` tier, on the theory that a symptom diverging from its cause would
be the hard case. Measurement refuted the framing. The `misleading` scenario
(`configmap-volume-missing`) turned out trivial, 1.00 cause accuracy for all three
models, while the real trap sat in the `obvious` tier, the crashloop case above.
So the tier grouping was demoted to a descriptive label, and an
obvious-minus-misleading accuracy gap metric was removed entirely: it was negative
for every model and meant nothing, because difficulty proved model-dependent
rather than a property of the tier.

The crashloop case itself was briefly reclassified as misleading on the same
decoy-log theory, then an 8-run measurement showed the agent reasons past the log
string, so it was returned to the obvious tier as an honest case.

Sample size was corrected the same way. An early single-run signal suggested one
model was the weak one. Raising N to 10 showed the per-cell variance was real, and
that only intervals over N make a model comparison trustworthy. A point estimate
at low N is not a fact.

## Scope and limits

Stated up front, because a careful reader will find them.

- Read-only by design. This diagnoses; it does not remediate. It is not a
  production SRE tool.
- A finite, known taxonomy of five scenarios. Real incidents are messier,
  multi-cause, and ambiguous.
- The LLM-as-judge introduces non-determinism into the prose score. It is
  mitigated by reporting the mean and standard deviation over N runs, and the
  committed reference report uses a deterministic string-overlap fallback judge so
  its numbers do not move.
- Single-container, single-namespace scenarios. Nothing here exercises
  cross-namespace or multi-container failure.

## Running it

```
pnpm install
pnpm build                    # static Next.js build of the dashboard from committed artifacts
```

```
pnpm capture --scenario <id>  # capture fixtures from a live local kind cluster (local only, mutates only its own namespace)
pnpm eval                     # full eval; defaults to the deterministic fake client (no cluster, no key), writes reports/run-report.json
pnpm eval --client anthropic  # run real models against committed fixtures; needs ANTHROPIC_API_KEY
pnpm matrix --opus --runs 10  # the model comparison: real models against committed fixtures, needs ANTHROPIC_API_KEY
pnpm test:self-correction     # deterministic regression test of the validation-and-correction loop; no key, no cluster
```

Only the capture step needs a local kind cluster. The eval and matrix read
committed fixtures and need only an API key when run against real models. The
deterministic fake path (default `pnpm eval` and the self-correction test) needs
neither. Prompt caching keeps the full three-model, N=10 matrix around $5.20
(Haiku $0.95, Sonnet $1.38, Opus $2.87), computed from the usage the API already
returned.

## Architecture map

```
src/
  core/
    types.ts                 the frozen contracts
    tools/                   read-only tool definitions and argument canonicalization
    providers/               the ToolProvider seam: FixtureProvider, LiveProvider, RecordingProvider
    agent/                   the reasoning loop, prompts, model clients (real and fake)
    eval/                    runner, scorer, Wilson-interval stats
  scenarios/                 seeded failures as data: manifests, ground truth, capture set
  fixtures/                  captured tool output, one file per canonical call
  app/                       the dashboard, a static read of committed reports
scripts/                     capture, eval, matrix, self-correction
reports/                     committed eval artifacts (model-matrix.json, run-report.json)
```

Each module knows nothing of another beyond its contract. Five contracts in
`src/core/types.ts` anchor the codebase, and everything binds to them:

- `ToolProvider` (`listTools`, `resolve`): the seam between the agent and the data
  source. The one interface with two indistinguishable implementations.
- `ToolCall`, `ToolResult`, `ToolDefinition`: the tool boundary. What the agent
  asks for and what comes back.
- `Scenario` and `GroundTruth`: a seeded failure and its known answer, including
  the expected evidence markers.
- `Diagnosis` (with `Evidence`): the agent's structured output. Every claim must
  cite the tool output that supports it.
- `RunReport`, `ScenarioScore`, `RunTrace`: the eval's output. Per-run traces,
  per-scenario scores on both axes, and the tier rollup.
