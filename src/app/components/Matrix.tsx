"use client";

import { useState } from "react";
import type {
  Interval,
  MatrixArtifact,
  MatrixCell,
  ModelSummary,
  ScenarioMeta,
} from "../lib/matrix";
import {
  accBand,
  buildRows,
  intervalWidth,
  modelLabel,
  pct,
  pct1,
} from "../lib/matrix";

// A single Wilson-interval readout. The point estimate is the number and the
// colored tick; the interval is the faint bracket behind it. Color encodes the
// accuracy band and is applied ONLY to the point (numeral + tick), never to the
// interval, so a wide bracket stays fully legible whatever the band.
function IntervalBar({
  label,
  point,
  ci,
  size = "primary",
}: {
  label: string;
  point: number;
  ci: Interval;
  size?: "primary" | "secondary";
}) {
  const band = accBand(point);
  const width = intervalWidth(ci);
  const title = `${label}: point ${point.toFixed(2)}, 95% CI [${ci.lower.toFixed(
    2,
  )}, ${ci.upper.toFixed(2)}] (width ${width.toFixed(2)})`;
  return (
    <div className={`metric metric-${size}`} title={title}>
      <div className="metric-head">
        <span className="metric-label">{label}</span>
        <span className={`metric-point band-${band}`}>
          {pct(point)}
          <span className="metric-unit">%</span>
        </span>
      </div>
      <div className="track" aria-hidden="true">
        <div
          className="track-range"
          style={{
            left: `${ci.lower * 100}%`,
            width: `${Math.max(width * 100, 0.6)}%`,
          }}
        />
        <div
          className={`track-tick band-${band}`}
          style={{ left: `${point * 100}%` }}
        />
      </div>
      <div className="metric-ci">
        [{pct(ci.lower)}, {pct(ci.upper)}]
      </div>
    </div>
  );
}

// The expanded detail for one cell: every metric with its interval drawn, the
// judge mean and spread, the scenario framing, and an honest note that example
// traces are not embedded in this artifact (with a link to the reference
// transcript that does show the tool-call sequence).
function CellDetail({
  cell,
  meta,
}: {
  cell: MatrixCell;
  meta: ScenarioMeta | undefined;
}) {
  const judgeSd =
    cell.rootCauseJudgeStdDev != null && cell.rootCauseJudgeStdDev > 0
      ? ` ± ${pct1(cell.rootCauseJudgeStdDev)}`
      : "";
  return (
    <div className="cell-detail">
      <div className="cd-headline">
        <span className="cd-model">{modelLabel(cell.model)}</span>
        <span className="cd-x">×</span>
        <span className="cd-scenario">{cell.scenarioId}</span>
        <span className={`tier-chip tier-${cell.tier}`}>{cell.tier}</span>
        <span className="cd-n">n = {cell.runs}</span>
      </div>

      {meta && <p className="cd-desc">{meta.description}</p>}

      <div className="cd-metrics">
        <IntervalBar
          label="symptom accuracy"
          point={cell.symptomAccuracy}
          ci={cell.symptomAccuracyCI}
        />
        <IntervalBar
          label="cause accuracy"
          point={cell.causeAccuracy}
          ci={cell.causeAccuracyCI}
        />
        <IntervalBar
          label="completion rate"
          point={cell.completionRate}
          ci={cell.completionRateCI}
        />
        <IntervalBar
          label="evidence recall"
          point={cell.evidenceRecall}
          ci={cell.evidenceRecallCI}
        />
      </div>

      <div className="cd-judge">
        <span className="metric-label">root-cause judge</span>
        <span className="cd-judge-val">
          {pct1(cell.rootCauseJudge)}
          <span className="metric-unit">%</span>
          <span className="cd-judge-sd">{judgeSd}</span>
        </span>
        <span className="cd-judge-note">
          mean of the LLM-as-judge rubric over {cell.runs} run(s); a continuous
          score, so it carries a standard deviation rather than a Wilson interval
        </span>
      </div>

      <p className="cd-trace-note">
        Example traces are not embedded in the matrix artifact. To see the agent
        actually reasoning — the tool-call sequence and the structured diagnosis
        — read the reference transcript for this scenario:{" "}
        <a href={`#run-${cell.scenarioId}`} className="cd-trace-link">
          {cell.scenarioId} ↓
        </a>
        .
      </p>
    </div>
  );
}

// One (model, scenario) cell in the grid: the two primary axes as interval
// bars, the two secondary metrics condensed below, and a run count. The whole
// cell is a toggle that opens its detail drawer.
function Cell({
  cell,
  expanded,
  onToggle,
}: {
  cell: MatrixCell | undefined;
  expanded: boolean;
  onToggle: () => void;
}) {
  if (!cell) {
    return <div className="cell cell-absent">not run</div>;
  }
  return (
    <button
      type="button"
      className={`cell${expanded ? " cell-open" : ""}`}
      onClick={onToggle}
      aria-expanded={expanded}
    >
      <div className="cell-top">
        <span className="cell-n">n={cell.runs}</span>
        <span className="cell-chevron" aria-hidden="true">
          {expanded ? "−" : "+"}
        </span>
      </div>
      <IntervalBar
        label="symptom"
        point={cell.symptomAccuracy}
        ci={cell.symptomAccuracyCI}
      />
      <IntervalBar
        label="cause"
        point={cell.causeAccuracy}
        ci={cell.causeAccuracyCI}
      />
      <div className="cell-secondary">
        <span>
          <span className="cs-k">comp</span> {pct(cell.completionRate)}
        </span>
        <span className="cs-dot">·</span>
        <span>
          <span className="cs-k">evid</span> {pct(cell.evidenceRecall)}
        </span>
      </div>
    </button>
  );
}

// The per-model tier rollup: the obvious/misleading cause accuracy and the gap
// between them — the eval's headline number. Rendered as a compact strip so it
// frames the grid without competing with it.
function ModelRollup({ summary }: { summary: ModelSummary }) {
  const byTier = new Map(summary.byTier.tiers.map((t) => [t.tier, t]));
  const obvious = byTier.get("obvious");
  const misleading = byTier.get("misleading");
  const gap = summary.byTier.causeAccuracyGap;
  return (
    <div className="rollup">
      <div className="rollup-model">{modelLabel(summary.model)}</div>
      <div className="rollup-tiers">
        <span className="rollup-tier">
          <span className="rt-label">obvious cause</span>
          <span className="rt-val">
            {obvious ? `${pct(obvious.causeAccuracy)}%` : "—"}
          </span>
        </span>
        <span className="rollup-tier">
          <span className="rt-label">misleading cause</span>
          <span className="rt-val">
            {misleading ? `${pct(misleading.causeAccuracy)}%` : "—"}
          </span>
        </span>
        <span className="rollup-tier rollup-gap">
          <span className="rt-label">gap</span>
          <span className="rt-val">
            {gap == null ? "n/a" : `${(gap * 100).toFixed(0)} pts`}
          </span>
        </span>
      </div>
      {gap == null && (
        <div className="rollup-note">
          the obvious-minus-misleading gap needs both tiers present
        </div>
      )}
    </div>
  );
}

export function Matrix({
  matrix,
  scenarioById,
}: {
  matrix: MatrixArtifact;
  scenarioById: Map<string, ScenarioMeta>;
}) {
  // Models present in the artifact, in declared order, restricted to those that
  // actually have cells so an empty column never renders.
  const present = new Set(matrix.cells.map((c) => c.model));
  const models = matrix.metadata.models.filter((m) => present.has(m));
  const modelList = models.length
    ? models
    : [...present];

  const rows = buildRows(matrix.cells, modelList, matrix.metadata.scenarioIds);

  // A single open cell at a time, keyed by "scenarioId|model".
  const [open, setOpen] = useState<string | null>(null);
  const toggle = (key: string) => setOpen((cur) => (cur === key ? null : key));

  const gridStyle = {
    gridTemplateColumns: `var(--label-col) repeat(${modelList.length}, minmax(200px, 1fr))`,
  };

  // Rows are already tier-ordered; emit a tier separator whenever the tier
  // changes so the obvious block and the misleading block read as distinct.
  let lastTier: string | null = null;

  return (
    <section className="matrix-section" aria-label="model by scenario matrix">
      <div className="matrix-legend">
        <span className="legend-item">
          <span className="legend-tick" /> point estimate
        </span>
        <span className="legend-item">
          <span className="legend-range" /> 95% CI [lower, upper]
        </span>
        <span className="legend-item">
          <span className="legend-swatch band-good" /> ≥80
        </span>
        <span className="legend-item">
          <span className="legend-swatch band-warn" /> 50–79
        </span>
        <span className="legend-item">
          <span className="legend-swatch band-crit" /> &lt;50
        </span>
        <span className="legend-hint">click a cell for the full breakdown</span>
      </div>

      <div className="matrix-scroll">
        <div className="grid" style={gridStyle}>
          {/* header row */}
          <div className="grid-corner">
            <span className="corner-y">scenario ↓</span>
            <span className="corner-x">model →</span>
          </div>
          {modelList.map((m) => (
            <div key={m} className="grid-model-head">
              <span className="gmh-label">{modelLabel(m)}</span>
              <span className="gmh-id">{m}</span>
            </div>
          ))}

          {rows.map((row) => {
            const meta = scenarioById.get(row.scenarioId);
            const tierBreak = row.tier !== lastTier;
            lastTier = row.tier;
            const openKey =
              open && open.startsWith(`${row.scenarioId}|`) ? open : null;
            return (
              <FragmentRow
                key={row.scenarioId}
                tierBreak={tierBreak}
                tier={row.tier}
                scenarioId={row.scenarioId}
                meta={meta}
                models={modelList}
                cellsByModel={row.cellsByModel}
                openKey={openKey}
                toggle={toggle}
              />
            );
          })}
        </div>
      </div>

      <div className="rollups">
        <h2 className="rollups-title">per-model rollup</h2>
        <div className="rollups-grid">
          {matrix.byModel
            .filter((m) => present.has(m.model))
            .map((m) => (
              <ModelRollup key={m.model} summary={m} />
            ))}
        </div>
      </div>
    </section>
  );
}

// One scenario's row: a tier separator (when the tier changes), the sticky
// scenario label, each model's cell, and — if a cell in this row is open — a
// full-width detail drawer spanning every column.
function FragmentRow({
  tierBreak,
  tier,
  scenarioId,
  meta,
  models,
  cellsByModel,
  openKey,
  toggle,
}: {
  tierBreak: boolean;
  tier: string;
  scenarioId: string;
  meta: ScenarioMeta | undefined;
  models: string[];
  cellsByModel: Record<string, MatrixCell | undefined>;
  openKey: string | null;
  toggle: (key: string) => void;
}) {
  const openModel = openKey ? openKey.split("|")[1] : null;
  const openCell = openModel ? cellsByModel[openModel] : undefined;
  return (
    <>
      {tierBreak && (
        <div className={`tier-row tier-${tier}`}>
          <span className="tier-mark" />
          <span className="tier-name">{tier} tier</span>
          <span className="tier-desc">
            {tier === "misleading"
              ? "the surface signal points at the wrong cause; the trap the eval exists to measure"
              : "the surface signal names the true cause"}
          </span>
        </div>
      )}

      <div className="grid-label">
        <span className="gl-id">{scenarioId}</span>
        {meta && <span className="gl-desc">{meta.description}</span>}
      </div>
      {models.map((m) => {
        const key = `${scenarioId}|${m}`;
        return (
          <Cell
            key={key}
            cell={cellsByModel[m]}
            expanded={openKey === key}
            onToggle={() => toggle(key)}
          />
        );
      })}

      {openCell && (
        <div className="detail-row">
          <CellDetail cell={openCell} meta={meta} />
        </div>
      )}
    </>
  );
}
