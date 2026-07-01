// Eval CLI.
//
// Runs a scenario N times against a chosen model client and writes a RunReport
// under reports/. The default is the FakeModelClient, so the committed run is
// deterministic and free.
//
// Usage:
//   pnpm eval                         fake client, 3 runs, the seeded scenario
//   pnpm eval --runs 5                fake client, 5 runs
//   pnpm eval --client anthropic      real model, needs ANTHROPIC_API_KEY
//   pnpm eval --scenario <id>         pick a scenario by id

import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";

import { AnthropicModelClient } from "../src/core/agent/anthropicModelClient";
import {
  FakeModelClient,
  buildCrashloopScript,
} from "../src/core/agent/fakeModelClient";
import type { ModelClient } from "../src/core/agent/modelClient";
import { runEval } from "../src/core/eval/runner";
import {
  makeModelJudge,
  stringOverlapJudge,
  type RootCauseJudge,
} from "../src/core/eval/scorer";
import { findScenario } from "../src/scenarios";

interface CliArgs {
  client: "fake" | "anthropic";
  runs: number;
  scenario: string;
}

function parseArgs(argv: string[]): CliArgs {
  const args: CliArgs = {
    client: "fake",
    runs: 3,
    scenario: "crashloopbackoff-bad-command",
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

async function main(): Promise<void> {
  const args = parseArgs(process.argv.slice(2));

  const runtime = findScenario(args.scenario);
  if (!runtime) {
    throw new Error(`unknown scenario: ${args.scenario}`);
  }

  let client: ModelClient;
  let judge: RootCauseJudge;
  if (args.client === "anthropic") {
    if (!process.env.ANTHROPIC_API_KEY) {
      throw new Error(
        "ANTHROPIC_API_KEY is not set; the anthropic client needs it",
      );
    }
    const anthropic = new AnthropicModelClient();
    client = anthropic;
    // The judge shares the same seam. This makes the eval non-deterministic.
    judge = makeModelJudge(anthropic);
  } else {
    client = new FakeModelClient(
      buildCrashloopScript(runtime.namespace, runtime.pod),
    );
    judge = stringOverlapJudge;
  }

  const createdAt = new Date().toISOString();
  const report = await runEval({
    runtime,
    client,
    judge,
    runs: args.runs,
    createdAt,
  });

  const outDir = path.resolve(process.cwd(), "reports");
  await mkdir(outDir, { recursive: true });
  const outPath = path.join(outDir, "run-report.json");
  await writeFile(outPath, JSON.stringify(report, null, 2) + "\n", "utf8");

  const score = report.scenarioScores[0];
  console.log(`wrote ${outPath}`);
  console.log(`model: ${report.model}`);
  console.log(
    `scenario ${score.scenarioId} (${score.tier}): ${score.runs} runs, ` +
      `classAccuracy ${score.classAccuracy.toFixed(2)}, ` +
      `evidenceRecall ${score.evidenceRecall.toFixed(2)}, ` +
      `rootCauseJudge ${score.rootCauseJudgeScore.toFixed(2)}`,
  );
}

main().catch((err) => {
  console.error(err instanceof Error ? err.message : err);
  process.exit(1);
});
