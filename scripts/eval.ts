// Eval CLI.
//
// Runs every seeded scenario N times against a chosen model client and writes a
// single combined RunReport under reports/. The default is the FakeModelClient,
// so the committed run is deterministic, cluster-free, and free to produce: each
// scenario has a scripted fake client that submits a valid one-shot diagnosis.
//
// Usage:
//   pnpm eval                         fake client, 3 runs, all seeded scenarios
//   pnpm eval --runs 5                fake client, 5 runs
//   pnpm eval --client anthropic      real model, needs ANTHROPIC_API_KEY and
//                                     captured fixtures for every scenario
//   pnpm eval --scenario <id>         restrict to one scenario by id

import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";

import { AnthropicModelClient } from "../src/core/agent/anthropicModelClient";
import {
  FakeModelClient,
  buildCrashloopScript,
  buildUnschedulableScript,
  buildServiceNoEndpointsScript,
  buildRbacDeniedScript,
} from "../src/core/agent/fakeModelClient";
import type { CompletionResult } from "../src/core/agent/modelClient";
import { submitDiagnosisDefinition } from "../src/core/agent/diagnosisSchema";
import type { ModelClient } from "../src/core/agent/modelClient";
import { runEval } from "../src/core/eval/runner";
import {
  makeModelJudge,
  stringOverlapJudge,
  type RootCauseJudge,
} from "../src/core/eval/scorer";
import { SCENARIOS, findScenario } from "../src/scenarios";
import type { RunReport, Scenario } from "../src/core/types";

// The scripted fake client per scenario. A scenario must appear here to run
// under the fake (deterministic) client. Adding a scenario means adding its
// builder here alongside its captureSet and registry entry.
const FAKE_SCRIPTS: Record<string, (ns: string) => CompletionResult[]> = {
  "crashloopbackoff-bad-command": buildCrashloopScript,
  "pod-unschedulable": buildUnschedulableScript,
  "service-no-endpoints": buildServiceNoEndpointsScript,
  "rbac-denied": buildRbacDeniedScript,
};

interface CliArgs {
  client: "fake" | "anthropic";
  runs: number;
  scenario?: string; // when set, restrict to one scenario; otherwise run all
}

function parseArgs(argv: string[]): CliArgs {
  const args: CliArgs = {
    client: "fake",
    runs: 3,
  };
  for (let i = 0; i < argv.length; i++) {
    const flag = argv[i];
    if (flag === "--client") {
      const v = argv[++i];
      if (v !== "fake" && v !== "anthropic") {
        throw new Error(`--client must be "fake" or "anthropic", got "${v}"`);
      }
      args.client = v;
    } else if (flag === "--runs") {
      args.runs = Number(argv[++i]);
      if (!Number.isInteger(args.runs) || args.runs < 1) {
        throw new Error("--runs must be a positive integer");
      }
    } else if (flag === "--scenario") {
      args.scenario = argv[++i];
    } else {
      throw new Error(`unknown argument: ${flag}`);
    }
  }
  return args;
}

// Deep-merge one scenario's confusion matrix rows into the combined matrix,
// summing counts. Distinct scenarios have distinct actual classes, so rows do
// not collide, but this is written to sum defensively.
function mergeConfusion(
  into: Record<string, Record<string, number>>,
  from: Record<string, Record<string, number>>,
): void {
  for (const [actual, row] of Object.entries(from)) {
    into[actual] ??= {};
    for (const [predicted, count] of Object.entries(row)) {
      into[actual][predicted] = (into[actual][predicted] ?? 0) + count;
    }
  }
}

async function main(): Promise<void> {
  const args = parseArgs(process.argv.slice(2));

  // Which scenarios to run: one if --scenario was given, otherwise all seeded.
  let scenarios: Scenario[];
  if (args.scenario) {
    const scenario = findScenario(args.scenario);
    if (!scenario) {
      throw new Error(`unknown scenario: ${args.scenario}`);
    }
    scenarios = [scenario];
  } else {
    scenarios = SCENARIOS;
  }

  // Once at startup: log the schema the model is actually shown for
  // submit_diagnosis and its required array, so a run can confirm suggestedFix
  // and confidence are advertised as required (they are the last two fields, the
  // ones a truncated turn drops first).
  const advertisedSchema = submitDiagnosisDefinition.inputSchema as {
    required?: string[];
  };
  console.error(
    `[eval] submit_diagnosis advertised schema: ${JSON.stringify(advertisedSchema)}`,
  );
  console.error(
    `[eval] submit_diagnosis required fields: ${JSON.stringify(advertisedSchema.required ?? [])}`,
  );

  // One Anthropic client and judge are shared across scenarios so a single
  // model seam drives the whole non-deterministic run. The fake client is per
  // scenario, since each scenario has its own scripted investigation.
  let anthropic: AnthropicModelClient | undefined;
  let modelJudge: RootCauseJudge | undefined;
  if (args.client === "anthropic") {
    if (!process.env.ANTHROPIC_API_KEY) {
      throw new Error(
        "ANTHROPIC_API_KEY is not set; the anthropic client needs it",
      );
    }
    anthropic = new AnthropicModelClient();
    // Report the output token ceiling this run operates under, so a truncation
    // failure can be read against the budget that produced it.
    console.error(`[eval] AnthropicModelClient max_tokens: ${anthropic.maxTokens}`);
    // The judge shares the same seam. This makes the eval non-deterministic.
    modelJudge = makeModelJudge(anthropic);
  }

  const createdAt = new Date().toISOString();

  // Accumulate every scenario into one combined RunReport.
  const combined: RunReport = {
    createdAt,
    model: args.client === "anthropic" ? anthropic!.model : "fake-model",
    scenarioScores: [],
    confusionMatrix: {},
    traces: [],
  };

  for (const scenario of scenarios) {
    let client: ModelClient;
    let judge: RootCauseJudge;
    if (args.client === "anthropic") {
      client = anthropic!;
      judge = modelJudge!;
    } else {
      const buildScript = FAKE_SCRIPTS[scenario.id];
      if (!buildScript) {
        throw new Error(
          `no fake-client script for scenario "${scenario.id}". Add one in ` +
            `fakeModelClient.ts and register it in FAKE_SCRIPTS, or run this ` +
            `scenario with --client anthropic.`,
        );
      }
      client = new FakeModelClient(buildScript(scenario.namespace));
      judge = stringOverlapJudge;
    }

    const report = await runEval({
      scenario,
      client,
      judge,
      runs: args.runs,
      createdAt,
    });

    combined.scenarioScores.push(...report.scenarioScores);
    combined.traces.push(...report.traces);
    mergeConfusion(combined.confusionMatrix, report.confusionMatrix);
  }

  const outDir = path.resolve(process.cwd(), "reports");
  await mkdir(outDir, { recursive: true });
  const outPath = path.join(outDir, "run-report.json");
  await writeFile(outPath, JSON.stringify(combined, null, 2) + "\n", "utf8");

  console.log(`wrote ${outPath}`);
  console.log(`model: ${combined.model}`);
  for (const score of combined.scenarioScores) {
    console.log(
      `scenario ${score.scenarioId} (${score.tier}): ${score.runs} runs, ` +
        `completionRate ${score.completionRate.toFixed(2)}, ` +
        `classAccuracy ${score.classAccuracy.toFixed(2)}, ` +
        `evidenceRecall ${score.evidenceRecall.toFixed(2)}, ` +
        `rootCauseJudge ${score.rootCauseJudgeScore.toFixed(2)}`,
    );
  }
}

main().catch((err) => {
  console.error(err instanceof Error ? err.message : err);
  process.exit(1);
});
