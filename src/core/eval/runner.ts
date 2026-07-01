// The eval runner.
//
// Runs one scenario N times against a chosen ModelClient and fixtures, scores
// the diagnoses against ground truth, and aggregates into a RunReport. Each run
// gets a fresh FixtureProvider, so runs are independent and reproducible.

import { runAgent, AgentRunError } from "../agent/loop";
import type { ModelClient } from "../agent/modelClient";
import type { AgentConfig } from "../agent/config";
import { FixtureProvider } from "../providers/fixtureProvider";
import type { RunReport, RunTrace } from "../types";
import type { ScenarioRuntime } from "../../scenarios";
import { scoreScenario, type RootCauseJudge } from "./scorer";

export interface RunEvalOptions {
  runtime: ScenarioRuntime;
  client: ModelClient;
  judge: RootCauseJudge;
  runs: number;
  // ISO timestamp for the report. Passed in so the runner stays free of clock
  // reads; the CLI stamps it.
  createdAt: string;
  config?: AgentConfig;
}

// Build the confusion matrix over failure classes from the run traces. With one
// scenario this is the trivial single-class case.
function buildConfusionMatrix(
  runtime: ScenarioRuntime,
  traces: RunTrace[],
): Record<string, Record<string, number>> {
  const actual = runtime.scenario.groundTruth.failureClass;
  const matrix: Record<string, Record<string, number>> = {};
  for (const trace of traces) {
    const predicted = trace.diagnosis.failureClass;
    matrix[actual] ??= {};
    matrix[actual][predicted] = (matrix[actual][predicted] ?? 0) + 1;
  }
  return matrix;
}

export async function runEval(options: RunEvalOptions): Promise<RunReport> {
  const { runtime, client, judge, runs, createdAt, config } = options;
  const { scenario, namespace } = runtime;

  const traces: RunTrace[] = [];
  for (let i = 0; i < runs; i++) {
    const provider = new FixtureProvider(scenario.id);
    try {
      const trace = await runAgent({
        scenarioId: scenario.id,
        namespace,
        provider,
        client,
        config,
      });
      traces.push(trace);
    } catch (err) {
      // A failed run does not produce a diagnosis. Log it and continue so one
      // bad run does not sink the report.
      // TODO: represent failed runs in the report rather than dropping them.
      if (err instanceof AgentRunError) {
        console.error(`run ${i} failed: ${err.message}`);
      } else {
        throw err;
      }
    }
  }

  if (traces.length === 0) {
    throw new Error(
      `no successful runs for scenario "${scenario.id}"; cannot write a report`,
    );
  }

  const scenarioScore = await scoreScenario(scenario, traces, judge);

  return {
    createdAt,
    model: client.model,
    scenarioScores: [scenarioScore],
    confusionMatrix: buildConfusionMatrix(runtime, traces),
    traces,
  };
}
