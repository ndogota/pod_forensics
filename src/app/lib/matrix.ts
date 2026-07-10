// Dashboard-side reading types for the model-matrix artifact.
//
// These describe the shape of reports/model-matrix.json as the dashboard reads
// it. They mirror the interfaces the matrix script writes (scripts/matrix.ts),
// but are declared here independently: the artifact is a script-level
// aggregation, not a frozen runtime contract, and the dashboard is pure
// presentation that must never import the capture/eval machinery. Keeping a
// local reading contract is the seam that lets the page build with nothing but
// the committed JSON.

export interface Interval {
  lower: number;
  upper: number;
}

// One (model, scenario) cell. Each proportion metric carries a Wilson 95% CI.
export interface MatrixCell {
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
  rootCauseJudge: number;
  rootCauseJudgeStdDev: number | null;
}

export interface TierRollup {
  tier: string;
  scenarioCount: number;
  completionRate: number;
  symptomAccuracy: number;
  causeAccuracy: number;
  evidenceRecall: number;
  rootCauseJudge: number;
}

export interface TierIntervals {
  tier: string;
  runs: number;
  completionRateCI: Interval;
  symptomAccuracyCI: Interval;
  causeAccuracyCI: Interval;
  evidenceRecallCI: Interval;
  rootCauseJudge: { mean: number; stdDev: number | null };
}

export interface ModelSummary {
  model: string;
  byTier: {
    tiers: TierRollup[];
  };
  tierIntervals: TierIntervals[];
  cost: {
    tokensIn: number;
    tokensOut: number;
    cacheReadTokens: number;
    estUsd: number;
    failedRuns: number;
  };
}

export interface MatrixArtifact {
  metadata: {
    models: string[];
    runsPerCell: number;
    scenarioIds: string[];
    judgeModel: string;
    createdAt: string;
    methodologyNote: string;
  };
  cells: MatrixCell[];
  byModel: ModelSummary[];
  cost: {
    perModelUsd: Record<string, number>;
    totalUsd: number;
  };
}

// Human-facing metadata per scenario, threaded in from the scenario registry at
// build time so the client bundle stays free of domain code. Falls back to the
// raw id when a scenario is absent from the registry.
export interface ScenarioMeta {
  id: string;
  description: string;
  tier: string;
}

// --- display helpers --------------------------------------------------------

// Tier display order. Tier is a descriptive grouping label, not a difficulty
// ranking; this only fixes a stable, consistent row order.
const TIER_ORDER: Record<string, number> = { obvious: 0, misleading: 1 };

export function tierRank(tier: string): number {
  return tier in TIER_ORDER ? TIER_ORDER[tier] : 99;
}

// A rate rendered as a percentage integer, e.g. 0.8 -> "80". Kept as a string
// so callers control the surrounding markup and the % sign.
export function pct(x: number): string {
  return (x * 100).toFixed(0);
}

export function pct1(x: number): string {
  return (x * 100).toFixed(1);
}

// Accuracy bands drive the sparing use of semantic color. The interval bar
// itself is never colored by this; only the point marker and the numeral are,
// so the uncertainty is always legible regardless of the band.
export type AccBand = "good" | "warn" | "crit";

export function accBand(x: number): AccBand {
  if (x >= 0.8) return "good";
  if (x >= 0.5) return "warn";
  return "crit";
}

// Width of a Wilson interval, 0..1. A wide value means low confidence; the bar
// renders this width directly so it reads at a glance.
export function intervalWidth(ci: Interval): number {
  return Math.max(0, ci.upper - ci.lower);
}

// Group cells into scenario rows in display order (tier, then artifact order),
// each row carrying the per-model cells keyed by model. Missing (model,
// scenario) combinations resolve to undefined so the grid can mark them absent
// rather than crash.
export interface ScenarioRow {
  scenarioId: string;
  tier: string;
  cellsByModel: Record<string, MatrixCell | undefined>;
}

export function buildRows(
  cells: MatrixCell[],
  models: string[],
  scenarioIds: string[],
): ScenarioRow[] {
  const byScenario = new Map<string, MatrixCell[]>();
  for (const c of cells) {
    const list = byScenario.get(c.scenarioId) ?? [];
    list.push(c);
    byScenario.set(c.scenarioId, list);
  }
  // Preserve the artifact's scenario order within a tier, tier order across.
  const order = scenarioIds.length
    ? scenarioIds
    : [...byScenario.keys()];
  const rows: ScenarioRow[] = order
    .filter((id) => byScenario.has(id))
    .map((id) => {
      const list = byScenario.get(id)!;
      const tier = list[0]?.tier ?? "obvious";
      const cellsByModel: Record<string, MatrixCell | undefined> = {};
      for (const m of models) {
        cellsByModel[m] = list.find((c) => c.model === m);
      }
      return { scenarioId: id, tier, cellsByModel };
    });
  // Stable sort by tier rank, keeping artifact order within a tier.
  return rows
    .map((r, i) => ({ r, i }))
    .sort((a, b) =>
      tierRank(a.r.tier) - tierRank(b.r.tier) || a.i - b.i,
    )
    .map(({ r }) => r);
}

// Short display label for a model id: drop the vendor prefix and the trailing
// date stamp so columns stay narrow. "claude-haiku-4-5-20251001" -> "haiku 4.5".
export function modelLabel(model: string): string {
  const m = model.match(
    /^claude-(haiku|sonnet|opus)-(\d+)-(\d+)(?:-\d{8})?$/,
  );
  if (m) return `${m[1]} ${m[2]}.${m[3]}`;
  return model.replace(/^claude-/, "");
}
