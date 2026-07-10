"use client";

import { useState } from "react";
import type { RunReport, RunTrace } from "../../core/types";
import type { ScenarioMeta } from "../lib/matrix";
import { tierRank } from "../lib/matrix";

function argsStr(args: Record<string, string>): string {
  return Object.entries(args)
    .map(([k, v]) => `${k}=${v}`)
    .join(", ");
}

// One scenario's reference trace as a terminal transcript: the tool-call
// sequence the agent chose, then the structured diagnosis it emitted. This is
// where a reader sees the loop actually reasoning, not just the aggregate.
function Transcript({
  trace,
  meta,
  open,
  onToggle,
}: {
  trace: RunTrace;
  meta: ScenarioMeta | undefined;
  open: boolean;
  onToggle: () => void;
}) {
  const d = trace.diagnosis;
  const tier = meta?.tier ?? "obvious";
  return (
    <article id={`run-${trace.scenarioId}`} className="run">
      <button
        type="button"
        className={`run-head${open ? " run-open" : ""}`}
        onClick={onToggle}
        aria-expanded={open}
      >
        <span className="run-chevron" aria-hidden="true">
          {open ? "▾" : "▸"}
        </span>
        <span className="run-id">{trace.scenarioId}</span>
        <span className={`tier-chip tier-${tier}`}>{tier}</span>
        <span className="run-summary">
          → <span className="run-cause">{d.rootCauseClass}</span>
          <span className="run-symptom"> / {d.symptom}</span>
        </span>
        <span className="run-steps">{trace.stepCount} steps</span>
      </button>

      {open && (
        <div className="run-body">
          <div className="transcript">
            <div className="tr-line tr-prompt">
              <span className="tr-caret">$</span> diagnose {trace.scenarioId}
            </div>
            {trace.steps.map((step) => (
              <div key={step.index} className="tr-line tr-call">
                <span className="tr-caret">→</span>
                <span className="tr-tool">{step.toolCall.tool}</span>
                <span className="tr-args">({argsStr(step.toolCall.args)})</span>
                <span className="tr-cost">
                  {step.latencyMs}ms · {step.tokensIn}↓ {step.tokensOut}↑
                </span>
              </div>
            ))}
            <div className="tr-line tr-done">
              <span className="tr-caret">✓</span> submit_diagnosis
            </div>
          </div>

          <div className="diagnosis">
            <div className="dg-row">
              <span className="dg-k">symptom</span>
              <span className="dg-v">{d.symptom}</span>
            </div>
            <div className="dg-row">
              <span className="dg-k">root cause</span>
              <span className="dg-v">{d.rootCauseClass}</span>
            </div>
            <div className="dg-row">
              <span className="dg-k">confidence</span>
              <span className="dg-v">{d.confidence.toFixed(2)}</span>
            </div>
            <p className="dg-prose">{d.rootCause}</p>
            <p className="dg-fix">
              <span className="dg-k">fix (advice only)</span> {d.suggestedFix}
            </p>
            <div className="dg-evidence">
              <span className="dg-k">cited evidence</span>
              <ul>
                {d.evidence.map((e, j) => (
                  <li key={j}>
                    <code>
                      {e.tool}({argsStr(e.args)})
                    </code>
                    <span className="ev-excerpt">{e.excerpt}</span>
                  </li>
                ))}
              </ul>
            </div>
          </div>

          <div className="run-cost">
            {trace.stepCount} steps · {trace.totalTokens} tokens · $
            {trace.costUsd.toFixed(4)} · {trace.totalLatencyMs}ms
          </div>
        </div>
      )}
    </article>
  );
}

// One representative trace per scenario (the first run), in tier order. The
// matrix headline aggregates many runs; this section shows a single concrete
// run so the reasoning is legible.
export function Runs({
  report,
  scenarioById,
}: {
  report: RunReport | null;
  scenarioById: Map<string, ScenarioMeta>;
}) {
  const [open, setOpen] = useState<Set<string>>(new Set());

  if (!report || report.traces.length === 0) {
    return null;
  }

  const seen = new Set<string>();
  const representative: RunTrace[] = [];
  for (const t of report.traces) {
    if (!seen.has(t.scenarioId)) {
      seen.add(t.scenarioId);
      representative.push(t);
    }
  }
  representative.sort(
    (a, b) =>
      tierRank(scenarioById.get(a.scenarioId)?.tier ?? "obvious") -
      tierRank(scenarioById.get(b.scenarioId)?.tier ?? "obvious"),
  );

  const toggle = (id: string) =>
    setOpen((cur) => {
      const next = new Set(cur);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });

  return (
    <section className="runs-section" aria-label="reference run transcripts">
      <div className="runs-head">
        <div className="eyebrow">reference transcripts</div>
        <h2 className="runs-title">One run, end to end</h2>
        <p className="runs-lede">
          A single representative run per scenario from the committed
          deterministic reference report (<code>{report.model}</code>,{" "}
          {report.traces.length} traces total). The matrix above is the
          aggregate; these show the tool-call sequence and the structured
          diagnosis for one concrete run, so the loop is legible rather than
          summarized. This is the single-model view; per-model matrix traces are
          not embedded in the matrix artifact.
        </p>
      </div>

      <div className="runs-list">
        {representative.map((t) => (
          <Transcript
            key={t.scenarioId}
            trace={t}
            meta={scenarioById.get(t.scenarioId)}
            open={open.has(t.scenarioId)}
            onToggle={() => toggle(t.scenarioId)}
          />
        ))}
      </div>
    </section>
  );
}
