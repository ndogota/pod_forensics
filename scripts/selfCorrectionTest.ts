// Offline self-correction test.
//
// Regression guard for the invalid-submit correction path. It runs the agent
// loop against committed fixtures with a scripted client whose first
// submit_diagnosis omits confidence and suggestedFix, and whose second submit is
// valid. It asserts four things:
//   1. the loop surfaces the validation error back to the model (an error
//      tool_result naming the missing fields),
//   2. the model self-corrects on the next turn,
//   3. the run completes with a valid diagnosis, and
//   4. the aggregate completionRate is 1.00 (with class accuracy and evidence
//      recall intact).
//
// It is deterministic and needs no ANTHROPIC_API_KEY. Run with:
//   pnpm test:self-correction

import {
  FakeModelClient,
  buildCrashloopSelfCorrectionScript,
} from "../src/core/agent/fakeModelClient";
import type {
  CompletionRequest,
  CompletionResult,
  ModelMessage,
} from "../src/core/agent/modelClient";
import { runEval } from "../src/core/eval/runner";
import { stringOverlapJudge } from "../src/core/eval/scorer";
import { findScenario } from "../src/scenarios";

// A FakeModelClient that records every request it is handed, so the test can
// inspect what the loop fed back between turns.
class RecordingFakeClient extends FakeModelClient {
  readonly requests: ModelMessage[][] = [];

  async complete(req: CompletionRequest): Promise<CompletionResult> {
    // Snapshot the messages as the loop presented them for this turn.
    this.requests.push([...req.messages]);
    return super.complete(req);
  }
}

function assert(condition: unknown, message: string): asserts condition {
  if (!condition) {
    throw new Error(`assertion failed: ${message}`);
  }
}

// Did any turn carry an error tool_result that reports the missing required
// fields? That is the proof the invalid submit was surfaced, not swallowed.
function correctionWasSurfaced(requests: ModelMessage[][]): boolean {
  for (const messages of requests) {
    for (const message of messages) {
      if (message.role !== "user" || typeof message.content === "string") {
        continue;
      }
      for (const result of message.content) {
        if (
          result.isError === true &&
          result.content.includes("confidence") &&
          result.content.includes("suggestedFix")
        ) {
          return true;
        }
      }
    }
  }
  return false;
}

async function main(): Promise<void> {
  const scenario = findScenario("crashloopbackoff-bad-command");
  assert(scenario, "the crashloop scenario must exist");

  const client = new RecordingFakeClient(
    buildCrashloopSelfCorrectionScript(scenario),
  );

  const { report } = await runEval({
    scenario,
    client,
    judge: stringOverlapJudge,
    runs: 1,
    createdAt: "1970-01-01T00:00:00.000Z",
  });

  // 1 + 2: the validation error was returned to the model, and it resubmitted.
  assert(
    correctionWasSurfaced(client.requests),
    "the loop should have returned an error tool_result naming the missing confidence and suggestedFix fields",
  );

  // 3: the run completed with a valid diagnosis.
  assert(
    report.traces.length === 1,
    `expected exactly one completed trace, got ${report.traces.length}`,
  );

  // 4: the aggregate scores are perfect, so a self-corrected run is scored no
  // differently from a one-shot valid run.
  const score = report.scenarioScores[0];
  assert(
    score.completionRate === 1,
    `expected completionRate 1.00, got ${score.completionRate}`,
  );
  assert(
    score.classAccuracy === 1,
    `expected classAccuracy 1.00, got ${score.classAccuracy}`,
  );
  assert(
    score.evidenceRecall === 1,
    `expected evidenceRecall 1.00, got ${score.evidenceRecall}`,
  );

  console.log(
    "PASS self-correction: invalid submit surfaced, model corrected, " +
      `run completed, completionRate ${score.completionRate.toFixed(2)}, ` +
      `classAccuracy ${score.classAccuracy.toFixed(2)}, ` +
      `evidenceRecall ${score.evidenceRecall.toFixed(2)}`,
  );
}

main().catch((err) => {
  console.error(err instanceof Error ? err.message : err);
  process.exit(1);
});
