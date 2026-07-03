// Hybrid scoring for a diagnosis against ground truth.
//
// Three signals, per the architecture:
//   - failureClass: exact match.
//   - evidenceRecall: key overlap between the cited excerpts and the expected
//     evidence markers.
//   - rootCauseJudgeScore: an LLM-as-judge rates the root-cause prose, with a
//     deterministic string-overlap fallback so scoring runs offline.
//
// Non-determinism caveat: using a model inside scoring makes the eval itself
// non-deterministic. That is a known soft spot. Runs are repeated N times and
// reported as a rate, and the committed run uses the deterministic fallback
// judge so its numbers do not move.

import type {
  Diagnosis,
  DifficultyTier,
  GroundTruth,
  RunTrace,
  Scenario,
  ScenarioScore,
} from "../types";
import type { ModelClient } from "../agent/modelClient";

// The result of one attempted run. A failed run has no diagnosis, so it cannot
// be a RunTrace. It is still counted, never dropped: it scores zero on every
// dimension and lowers the completion rate.
export type RunOutcome =
  | { status: "ok"; trace: RunTrace }
  | { status: "failed"; error: string };

// A judge scores how well a predicted root cause matches the canonical one, in
// the range 0..1.
export type RootCauseJudge = (
  predicted: string,
  canonical: string,
) => Promise<number>;

export function classCorrect(
  diagnosis: Diagnosis,
  groundTruth: GroundTruth,
): boolean {
  return diagnosis.failureClass === groundTruth.failureClass;
}

// Fraction of expected evidence markers that appear in the cited excerpts.
// Matching is case-insensitive substring, so "CrashLoopBackOff" matches an
// excerpt that mentions it in any casing.
export function evidenceRecall(
  diagnosis: Diagnosis,
  groundTruth: GroundTruth,
): number {
  const expected = groundTruth.expectedEvidence;
  if (expected.length === 0) return 1;
  const haystack = diagnosis.evidence
    .map((e) => e.excerpt.toLowerCase())
    .join("\n");
  const hits = expected.filter((marker) =>
    haystack.includes(marker.toLowerCase()),
  ).length;
  return hits / expected.length;
}

function tokenize(text: string): Set<string> {
  return new Set(
    text
      .toLowerCase()
      .split(/[^a-z0-9]+/)
      .filter((t) => t.length > 2),
  );
}

// Deterministic fallback judge: containment of the canonical root-cause tokens
// within the predicted root cause. No model, so it is stable and free.
export const stringOverlapJudge: RootCauseJudge = async (
  predicted,
  canonical,
) => {
  const canon = tokenize(canonical);
  if (canon.size === 0) return 1;
  const pred = tokenize(predicted);
  let shared = 0;
  for (const t of canon) if (pred.has(t)) shared++;
  return shared / canon.size;
};

// LLM-as-judge behind the same ModelClient seam. Asks the model for a single
// number and parses it. Non-deterministic by nature; use the fallback for the
// committed run.
export function makeModelJudge(client: ModelClient): RootCauseJudge {
  return async (predicted, canonical) => {
    const result = await client.complete({
      system:
        "You grade how well a predicted root cause matches a canonical root cause for a Kubernetes failure. Reply with a single number from 0 to 1 and nothing else. 1 means the same root cause, 0 means unrelated.",
      messages: [
        {
          role: "user",
          content: `Canonical root cause:\n${canonical}\n\nPredicted root cause:\n${predicted}\n\nScore from 0 to 1:`,
        },
      ],
      tools: [],
      maxTokens: 16,
    });
    const text = result.content
      .map((b) => (b.type === "text" ? b.text : ""))
      .join(" ");
    const match = text.match(/\d*\.?\d+/);
    if (!match) return 0;
    const score = Number(match[0]);
    if (Number.isNaN(score)) return 0;
    return Math.max(0, Math.min(1, score));
  };
}

function mean(values: number[]): number {
  if (values.length === 0) return 0;
  return values.reduce((a, b) => a + b, 0) / values.length;
}

// Aggregate the scores for one scenario across N attempted runs. Failed runs
// count as zero on every dimension, so averages divide by attempts, not by
// successes. completionRate reports the fraction that produced a valid
// diagnosis.
export async function scoreScenario(
  scenario: Scenario,
  outcomes: RunOutcome[],
  judge: RootCauseJudge,
): Promise<ScenarioScore> {
  const gt = scenario.groundTruth;
  const attempted = outcomes.length;

  const classScores = outcomes.map((o) =>
    o.status === "ok" && classCorrect(o.trace.diagnosis, gt) ? 1 : 0,
  );
  const recallScores = outcomes.map((o) =>
    o.status === "ok" ? evidenceRecall(o.trace.diagnosis, gt) : 0,
  );
  const judgeScores = await Promise.all(
    outcomes.map((o) =>
      o.status === "ok"
        ? judge(o.trace.diagnosis.rootCause, gt.rootCause)
        : Promise.resolve(0),
    ),
  );
  const completed = outcomes.filter((o) => o.status === "ok").length;

  const tier: DifficultyTier = scenario.tier;
  return {
    scenarioId: scenario.id,
    tier,
    runs: attempted,
    completionRate: attempted === 0 ? 0 : completed / attempted,
    classAccuracy: mean(classScores),
    evidenceRecall: mean(recallScores),
    rootCauseJudgeScore: mean(judgeScores),
  };
}
