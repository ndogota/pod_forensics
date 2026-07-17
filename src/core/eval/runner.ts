// The eval runner.
//
// Runs one scenario N times against a chosen ModelClient and fixtures, records
// the outcome of every run, scores against ground truth, and aggregates into a
// RunReport. Each run gets a fresh FixtureProvider, so runs are independent and
// reproducible. No run is ever silently dropped: a failed run is recorded and
// counts as zero in the scores, and the per-scenario completionRate reports how
// many runs produced a valid diagnosis.

import { runAgent, AgentRunError, type RunUsage } from "../agent/loop";
import type { ModelClient } from "../agent/modelClient";
import type { AgentConfig } from "../agent/config";
import { FixtureProvider } from "../providers/fixtureProvider";
import type { RunReport, RunTrace, Scenario } from "../types";
import {
  scoreScenario,
  summarizeByTier,
  type RootCauseJudge,
  type RunOutcome,
} from "./scorer";

export interface RunEvalOptions {
  scenario: Scenario;
  client: ModelClient;
  judge: RootCauseJudge;
  runs: number;
  // ISO timestamp for the report. Passed in so the runner stays free of clock
  // reads; the CLI stamps it.
  createdAt: string;
  config?: AgentConfig;
}

// Token usage from one failed run, tagged with its scenario. The frozen
// RunReport holds only successful RunTraces, so failed-run tokens cannot live
// there. They ride alongside the report instead, purely so the cost summary can
// price them; nothing here feeds scoring.
export interface FailedRunUsage {
  scenarioId: string;
  usage: RunUsage;
}

// What runEval returns: the RunReport plus the usage of any runs that failed and
// produced no trace, plus the raw per-run root-cause judge scores. All three ride
// alongside the frozen RunReport rather than inside it, so its shape is untouched.
// judgeScores lets a caller report the judge's spread (the matrix computes its
// standard deviation from them) without re-invoking the judge.
export interface RunEvalResult {
  report: RunReport;
  failedRuns: FailedRunUsage[];
  judgeScores: number[];
}

// Build the confusion matrix over root-cause classes from the successful traces.
// The cause is the interesting axis; a symptom-only match is not enough. With
// one scenario this is the trivial single-class case.
function buildConfusionMatrix(
  scenario: Scenario,
  traces: RunTrace[],
): Record<string, Record<string, number>> {
  const actual = scenario.groundTruth.rootCauseClass;
  const matrix: Record<string, Record<string, number>> = {};
  for (const trace of traces) {
    const predicted = trace.diagnosis.rootCauseClass;
    matrix[actual] ??= {};
    matrix[actual][predicted] = (matrix[actual][predicted] ?? 0) + 1;
  }
  return matrix;
}

export async function runEval(options: RunEvalOptions): Promise<RunEvalResult> {
  const { scenario, client, judge, runs, createdAt, config } = options;

  const outcomes: RunOutcome[] = [];
  for (let i = 0; i < runs; i++) {
    const provider = new FixtureProvider(scenario.id);
    try {
      const trace = await runAgent({
        scenarioId: scenario.id,
        namespace: scenario.namespace,
        provider,
        client,
        config,
      });
      outcomes.push({ status: "ok", trace });
    } catch (err) {
      if (err instanceof AgentRunError) {
        // Record the failure; do not drop it. It counts as zero in scoring and
        // lowers the completion rate. Carry the usage it spent before failing so
        // the cost summary can still price it.
        console.error(`run ${i} failed and was recorded: ${err.message}`);
        outcomes.push({
          status: "failed",
          error: err.message,
          usage: err.usage,
        });
      } else {
        throw err;
      }
    }
  }

  const traces = outcomes
    .filter(
      (o): o is Extract<RunOutcome, { status: "ok" }> => o.status === "ok",
    )
    .map((o) => o.trace);

  const failedRuns: FailedRunUsage[] = outcomes
    .filter(
      (o): o is Extract<RunOutcome, { status: "failed" }> =>
        o.status === "failed",
    )
    .filter((o) => o.usage !== undefined)
    .map((o) => ({ scenarioId: scenario.id, usage: o.usage! }));

  const { score: scenarioScore, judgeScores } = await scoreScenario(
    scenario,
    outcomes,
    judge,
  );

  return {
    report: {
      createdAt,
      model: client.model,
      scenarioScores: [scenarioScore],
      byTier: summarizeByTier([scenarioScore]),
      confusionMatrix: buildConfusionMatrix(scenario, traces),
      traces,
    },
    failedRuns,
    judgeScores,
  };
}
