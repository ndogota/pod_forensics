// Multi-model eval matrix.
//
// Runs the eval across a configurable set of agent models against every seeded
// scenario, N runs per (model, scenario) cell, and writes one self-describing
// artifact reports/model-matrix.json. This is the showcase artifact behind the
// model-by-scenario comparison: it answers "which model gets which scenario
// right, how often, and at what cost".
//
// It complements pnpm eval, which stays a single-model runner writing
// reports/run-report.json. This script never touches that path or that output.
//
// Unlike pnpm eval (which defaults to the deterministic fake client), the matrix
// is inherently a real-model comparison, so it always uses the Anthropic client
// and requires ANTHROPIC_API_KEY plus captured fixtures for every scenario. The
// judge is pinned to the cheapest model (Haiku) for every model under test, so
// scoring is consistent across the row being compared and never rides on the
// (possibly Opus) agent model.
//
// Usage:
//   pnpm matrix                         Haiku + Sonnet, 8 runs each, all scenarios
//   pnpm matrix --runs 4                4 runs per (model, scenario) cell
//   pnpm matrix --opus                  add Opus to the default pair (costs more)
//   pnpm matrix --models a,b,c          override the model list entirely
//   pnpm matrix --scenario <id>         restrict to one scenario (cheap testing)
//
// Cost is printed and stored per model and overall, computed purely from the
// usage the API already returned (no extra network). Run one small matrix first
// (for example --runs 1 --scenario crashloopbackoff-bad-command) to see the
// per-cell cost before committing to the full matrix repeatedly.

import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";

import { AnthropicModelClient } from "../src/core/agent/anthropicModelClient";
import { estimateCostUsd } from "../src/core/agent/pricing";
import { runEval, type FailedRunUsage } from "../src/core/eval/runner";
import {
  makeModelJudge,
  summarizeByTier,
  type RootCauseJudge,
} from "../src/core/eval/scorer";
import {
  wilsonInterval,
  meanStdDev,
  type Interval,
  type MeanStdDev,
} from "../src/core/eval/stats";
import { SCENARIOS, findScenario } from "../src/scenarios";
import type {
  ByTierSummary,
  RunTrace,
  Scenario,
  ScenarioScore,
} from "../src/core/types";

// The judge always runs on the cheapest model, for every model under test, so a
// row of the matrix is scored by one consistent judge.
const JUDGE_MODEL = "claude-haiku-4-5-20251001";

// The default pair of agent models compared. Kept off Opus by default to control
// cost; --opus opts it in, --models replaces the list entirely.
const DEFAULT_MODELS = ["claude-haiku-4-5-20251001", "claude-sonnet-4-6"];
const OPUS_MODEL = "claude-opus-4-8";

// --- Artifact shape ---------------------------------------------------------
// Defined locally, not in the frozen core types: this is a script-level
// aggregation artifact, not a runtime contract. It reuses the frozen
// ByTierSummary for the per-model tier rollup so the tier math is identical to
// pnpm eval's.

// One (model, scenario) cell: the six per-cell metrics the showcase compares.
// Each of the four proportion metrics carries a Wilson 95 percent confidence
// interval over the cell's N runs alongside its point estimate, so a reader sees
// the uncertainty and not just the point. The root-cause judge is a mean of
// continuous scores rather than a proportion of runs, so it reports a standard
// deviation over the runs instead of a Wilson interval.
interface MatrixCell {
  model: string;
  scenarioId: string;
  tier: string;
  runs: number;
  completionRate: number;
  completionRateCI: Interval;
  symptomAccuracy: number;
  symptomAccuracyCI: Interval;
  causeAccuracy: number;
  causeAccuracyCI: Interval;
  evidenceRecall: number;
  evidenceRecallCI: Interval;
  rootCauseJudge: number; // ScenarioScore.rootCauseJudgeScore mean, renamed for the artifact
  rootCauseJudgeStdDev: number; // sample standard deviation of the per-run judge scores
}

// Per-model, per-tier uncertainty. Parallel to ByTierSummary (which stays the
// frozen point-estimate rollup): the frozen TierSummary type has no room for
// intervals, so the matrix carries them here instead. Each interval is
// recomputed from scratch over every run in the tier (runs = scenarios in tier x
// runs per cell), never averaged from the per-cell intervals, so the interval
// tightens with the tier's larger N as it should.
interface TierIntervals {
  tier: string;
  runs: number; // total attempted runs pooled across the tier's scenarios
  completionRateCI: Interval;
  symptomAccuracyCI: Interval;
  causeAccuracyCI: Interval;
  evidenceRecallCI: Interval;
  rootCauseJudge: MeanStdDev; // mean and standard deviation over all judge scores in the tier
}

// Token totals and estimated USD for one model across the whole matrix. estUsd
// sums the accurate per-run costUsd already on each trace (which includes cache
// writes) plus a re-derived cost for failed runs, which carry only in/out/cache
// -read usage and so omit cache-write cost. Failed runs are rare, so this is a
// slight and clearly-noted understatement, not a silent one.
interface ModelCost {
  tokensIn: number;
  tokensOut: number;
  cacheReadTokens: number;
  estUsd: number;
  failedRuns: number;
}

interface ModelSummary {
  model: string;
  byTier: ByTierSummary; // per-model tier aggregates (point estimates)
  tierIntervals: TierIntervals[]; // per-tier uncertainty, obvious before misleading
  cost: ModelCost;
}

interface MatrixArtifact {
  // Self-describing metadata block: everything needed to read the matrix without
  // the command that produced it.
  metadata: {
    models: string[]; // agent models compared, in row order
    runsPerCell: number; // N: runs per (model, scenario) pair
    scenarioIds: string[];
    judgeModel: string; // held constant across all models for consistent scoring
    createdAt: string;
    methodologyNote: string; // how to read the intervals on every cell and tier
  };
  cells: MatrixCell[];
  byModel: ModelSummary[];
  cost: {
    perModelUsd: Record<string, number>;
    totalUsd: number;
  };
}

// --- CLI ---------------------------------------------------------------------

interface CliArgs {
  runs: number;
  models: string[];
  scenario?: string;
}

function parseArgs(argv: string[]): CliArgs {
  const args: CliArgs = { runs: 8, models: [...DEFAULT_MODELS] };
  let modelsOverridden = false;
  let opus = false;
  for (let i = 0; i < argv.length; i++) {
    const flag = argv[i];
    if (flag === "--runs") {
      args.runs = Number(argv[++i]);
      if (!Number.isInteger(args.runs) || args.runs < 1) {
        throw new Error("--runs must be a positive integer");
      }
    } else if (flag === "--models") {
      const v = argv[++i];
      if (!v) throw new Error("--models requires a comma-separated model list");
      args.models = v
        .split(",")
        .map((m) => m.trim())
        .filter((m) => m.length > 0);
      if (args.models.length === 0) {
        throw new Error("--models must list at least one model id");
      }
      modelsOverridden = true;
    } else if (flag === "--opus") {
      opus = true;
    } else if (flag === "--scenario") {
      args.scenario = argv[++i];
      if (!args.scenario) throw new Error("--scenario requires a scenario id");
    } else {
      throw new Error(`unknown argument: ${flag}`);
    }
  }
  // --opus adds Opus to the default pair. It is ignored when --models has already
  // named the exact list explicitly, so the two flags never fight.
  if (opus && !modelsOverridden && !args.models.includes(OPUS_MODEL)) {
    args.models.push(OPUS_MODEL);
  }
  return args;
}

// Fold one model's traces and failed runs into a ModelCost. Successful runs use
// the accurate per-trace costUsd (cache writes included); failed runs are priced
// from their in/out/cache-read usage, which omits cache-write cost.
function costForModel(
  model: string,
  traces: RunTrace[],
  failedRuns: FailedRunUsage[],
): ModelCost {
  let tokensIn = 0;
  let tokensOut = 0;
  let cacheReadTokens = 0;
  let estUsd = 0;
  for (const t of traces) {
    tokensIn += t.tokensIn;
    tokensOut += t.tokensOut;
    cacheReadTokens += t.cacheReadTokens;
    estUsd += t.costUsd;
  }
  for (const f of failedRuns) {
    tokensIn += f.usage.tokensIn;
    tokensOut += f.usage.tokensOut;
    cacheReadTokens += f.usage.cacheReadTokens;
    estUsd += estimateCostUsd(model, {
      inputTokens: f.usage.tokensIn,
      outputTokens: f.usage.tokensOut,
      cacheReadTokens: f.usage.cacheReadTokens,
    });
  }
  return {
    tokensIn,
    tokensOut,
    cacheReadTokens,
    estUsd,
    failedRuns: failedRuns.length,
  };
}

// "[0.49, 0.94]" for a CLI line. Two decimals, matching the point estimates.
function fmtInterval(ci: Interval): string {
  return `[${ci.lower.toFixed(2)}, ${ci.upper.toFixed(2)}]`;
}

// Recompute the per-tier Wilson intervals for one model by pooling every run in
// the tier, never by averaging the per-cell intervals. runsPerScenario is
// constant across a model's cells, so the pooled point estimate equals the
// frozen ByTierSummary mean; pooling here is what gives the interval its larger
// N (and so its tighter width) than any single cell. Judge scores pool the same
// way into one mean and standard deviation over the whole tier.
function buildTierIntervals(
  scores: ScenarioScore[],
  judgeScoresByScenario: number[][],
): TierIntervals[] {
  const order: string[] = ["obvious", "misleading"];
  const out: TierIntervals[] = [];
  for (const tier of order) {
    const idx = scores
      .map((s, i) => ({ s, i }))
      .filter(({ s }) => s.tier === tier);
    if (idx.length === 0) continue;

    const totalRuns = idx.reduce((a, { s }) => a + s.runs, 0);
    // Runs-weighted pooled proportion. Equal runs per cell make this the plain
    // mean, but weighting keeps it correct if a cell ever has fewer runs.
    const pooled = (pick: (s: ScenarioScore) => number): number =>
      totalRuns === 0
        ? 0
        : idx.reduce((a, { s }) => a + pick(s) * s.runs, 0) / totalRuns;
    const tierJudgeScores = idx.flatMap(({ i }) => judgeScoresByScenario[i]);

    out.push({
      tier,
      runs: totalRuns,
      completionRateCI: wilsonInterval(pooled((s) => s.completionRate), totalRuns),
      symptomAccuracyCI: wilsonInterval(pooled((s) => s.symptomAccuracy), totalRuns),
      causeAccuracyCI: wilsonInterval(pooled((s) => s.causeAccuracy), totalRuns),
      evidenceRecallCI: wilsonInterval(pooled((s) => s.evidenceRecall), totalRuns),
      rootCauseJudge: meanStdDev(tierJudgeScores),
    });
  }
  return out;
}

async function main(): Promise<void> {
  const args = parseArgs(process.argv.slice(2));

  if (!process.env.ANTHROPIC_API_KEY) {
    throw new Error(
      "ANTHROPIC_API_KEY is not set; the matrix runs real models and needs it",
    );
  }

  // Which scenarios: one if --scenario, otherwise all seeded.
  let scenarios: Scenario[];
  if (args.scenario) {
    const scenario = findScenario(args.scenario);
    if (!scenario) throw new Error(`unknown scenario: ${args.scenario}`);
    scenarios = [scenario];
  } else {
    scenarios = SCENARIOS;
  }

  const createdAt = new Date().toISOString();

  // One judge client, pinned to the cheapest model and shared across every model
  // under test, so a row of the matrix is scored consistently.
  const judgeClient = new AnthropicModelClient({ model: JUDGE_MODEL });
  const judge: RootCauseJudge = makeModelJudge(judgeClient);

  console.error(
    `[matrix] models: ${args.models.join(", ")}; scenarios: ${scenarios
      .map((s) => s.id)
      .join(", ")}; runs/cell: ${args.runs}; judge: ${JUDGE_MODEL}`,
  );
  console.error(
    `[matrix] full matrix = ${args.models.length} model(s) x ${scenarios.length} scenario(s) x ${args.runs} run(s) = ${args.models.length * scenarios.length * args.runs} runs`,
  );

  const cells: MatrixCell[] = [];
  const byModel: ModelSummary[] = [];
  const perModelUsd: Record<string, number> = {};

  for (const model of args.models) {
    // One agent client per model, reused across scenarios so the static system
    // prompt and tool-block prefix can stay warm in the prompt cache between
    // scenarios of the same model.
    const client = new AnthropicModelClient({ model });
    console.error(
      `\n[matrix] === model ${client.model} (max_tokens ${client.maxTokens}) ===`,
    );

    const modelScores: ScenarioScore[] = [];
    // Raw per-run judge scores per scenario, in the same order as modelScores, so
    // the tier rollup can pool them for a tier-wide mean and standard deviation.
    const modelJudgeScores: number[][] = [];
    const modelTraces: RunTrace[] = [];
    const modelFailed: FailedRunUsage[] = [];

    for (const scenario of scenarios) {
      const { report, failedRuns, judgeScores } = await runEval({
        scenario,
        client,
        judge,
        runs: args.runs,
        createdAt,
      });
      const score = report.scenarioScores[0];
      modelScores.push(score);
      modelJudgeScores.push(judgeScores);
      modelTraces.push(...report.traces);
      modelFailed.push(...failedRuns);

      // The four proportion metrics get a Wilson interval over this cell's N
      // runs; the judge gets the standard deviation of its per-run scores (the
      // mean is already the point estimate).
      cells.push({
        model: client.model,
        scenarioId: score.scenarioId,
        tier: score.tier,
        runs: score.runs,
        completionRate: score.completionRate,
        completionRateCI: wilsonInterval(score.completionRate, score.runs),
        symptomAccuracy: score.symptomAccuracy,
        symptomAccuracyCI: wilsonInterval(score.symptomAccuracy, score.runs),
        causeAccuracy: score.causeAccuracy,
        causeAccuracyCI: wilsonInterval(score.causeAccuracy, score.runs),
        evidenceRecall: score.evidenceRecall,
        evidenceRecallCI: wilsonInterval(score.evidenceRecall, score.runs),
        rootCauseJudge: score.rootCauseJudgeScore,
        rootCauseJudgeStdDev: meanStdDev(judgeScores).stdDev,
      });

      // Per-run cache diagnostic (Quest 4). A successful run that read nothing
      // from the prompt cache missed it, which is where cost silently rises. The
      // frozen RunTrace records cache reads but not cache writes, so this reports
      // the read side; the loop's own "[loop] cache summary" stderr line carries
      // cacheWrite when the full picture is needed.
      report.traces.forEach((t, i) => {
        const engaged = t.cacheReadTokens > 0;
        console.error(
          `[matrix] cache ${client.model} / ${scenario.id} run ${i}: ` +
            `cacheRead=${t.cacheReadTokens} -> ${engaged ? "ENGAGED" : "MISSED (no prompt cache hit)"}`,
        );
      });
      const missed = report.traces.filter((t) => t.cacheReadTokens === 0).length;
      if (missed > 0) {
        console.error(
          `[matrix] cache WARNING ${client.model} / ${scenario.id}: ${missed}/${report.traces.length} completed run(s) missed cache`,
        );
      }
    }

    const cost = costForModel(client.model, modelTraces, modelFailed);
    perModelUsd[client.model] = cost.estUsd;
    byModel.push({
      model: client.model,
      byTier: summarizeByTier(modelScores),
      tierIntervals: buildTierIntervals(modelScores, modelJudgeScores),
      cost,
    });
  }

  const totalUsd = Object.values(perModelUsd).reduce((a, b) => a + b, 0);

  const artifact: MatrixArtifact = {
    metadata: {
      models: args.models,
      runsPerCell: args.runs,
      scenarioIds: scenarios.map((s) => s.id),
      judgeModel: JUDGE_MODEL,
      createdAt,
      methodologyNote:
        `completionRate, symptomAccuracy, causeAccuracy and evidenceRecall carry ` +
        `a Wilson score 95% confidence interval (lower, upper) over the N runs of ` +
        `each cell (N = runsPerCell = ${args.runs}); per-tier intervals recompute ` +
        `over all runs in the tier. Intervals widen at low N: with only a handful ` +
        `of runs a point estimate is uncertain, and a rate of 1.0 gives an ` +
        `asymmetric interval whose upper bound is 1 but whose lower bound sits ` +
        `well below it. rootCauseJudge is a mean of continuous judge scores, not a ` +
        `proportion of runs, so it reports mean and standard deviation instead of ` +
        `a Wilson interval.`,
    },
    cells,
    byModel,
    cost: { perModelUsd, totalUsd },
  };

  const outDir = path.resolve(process.cwd(), "reports");
  await mkdir(outDir, { recursive: true });
  const outPath = path.join(outDir, "model-matrix.json");
  await writeFile(outPath, JSON.stringify(artifact, null, 2) + "\n", "utf8");

  // --- Console summary -------------------------------------------------------
  console.log(`\nwrote ${outPath}`);
  console.log(
    `models: ${args.models.join(", ")}; runs/cell: ${args.runs}; judge: ${JUDGE_MODEL}`,
  );

  console.log(
    "\nmatrix (model x scenario), point [lower, upper] = Wilson 95% CI over N runs:",
  );
  for (const cell of cells) {
    console.log(
      `  ${cell.model} / ${cell.scenarioId} (${cell.tier}): ${cell.runs} runs, ` +
        `completionRate ${cell.completionRate.toFixed(2)} ${fmtInterval(cell.completionRateCI)}, ` +
        `symptomAccuracy ${cell.symptomAccuracy.toFixed(2)} ${fmtInterval(cell.symptomAccuracyCI)}, ` +
        `causeAccuracy ${cell.causeAccuracy.toFixed(2)} ${fmtInterval(cell.causeAccuracyCI)}, ` +
        `evidenceRecall ${cell.evidenceRecall.toFixed(2)} ${fmtInterval(cell.evidenceRecallCI)}, ` +
        `rootCauseJudge ${cell.rootCauseJudge.toFixed(2)} +/- ${cell.rootCauseJudgeStdDev.toFixed(2)}`,
    );
  }

  console.log("\nper-model tiers (point [lower, upper] = Wilson 95% CI over all tier runs):");
  for (const m of byModel) {
    // Pair each tier's point-estimate rollup with its recomputed intervals.
    const ciByTier = new Map(m.tierIntervals.map((t) => [t.tier, t]));
    for (const tier of m.byTier.tiers) {
      const ci = ciByTier.get(tier.tier);
      console.log(
        `  ${m.model} ${tier.tier} (${tier.scenarioCount} scenario(s), ${ci?.runs ?? 0} runs): ` +
          `causeAccuracy ${tier.causeAccuracy.toFixed(2)} ${ci ? fmtInterval(ci.causeAccuracyCI) : ""}, ` +
          `symptomAccuracy ${tier.symptomAccuracy.toFixed(2)} ${ci ? fmtInterval(ci.symptomAccuracyCI) : ""}, ` +
          `evidenceRecall ${tier.evidenceRecall.toFixed(2)} ${ci ? fmtInterval(ci.evidenceRecallCI) : ""}, ` +
          `rootCauseJudge ${tier.rootCauseJudge.toFixed(2)} +/- ${(ci?.rootCauseJudge.stdDev ?? 0).toFixed(2)}`,
      );
    }
  }

  console.log(
    "\ncost summary (arithmetic on returned usage, no network; failed runs omit cache-write cost):",
  );
  for (const m of byModel) {
    const note = m.cost.failedRuns > 0 ? ` (includes ${m.cost.failedRuns} failed run(s))` : "";
    console.log(
      `  ${m.model}: in ${m.cost.tokensIn}, out ${m.cost.tokensOut}, ` +
        `cacheRead ${m.cost.cacheReadTokens}, est $${m.cost.estUsd.toFixed(4)}${note}`,
    );
  }
  console.log(`  TOTAL: est $${totalUsd.toFixed(4)}`);
}

main().catch((err) => {
  console.error(err instanceof Error ? err.message : err);
  process.exit(1);
});
