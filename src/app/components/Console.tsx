"use client";

import type { RunReport } from "../../core/types";
import type { MatrixArtifact, MatrixCell, ScenarioMeta } from "../lib/matrix";
import { accBand, modelLabel, pct } from "../lib/matrix";
import { Matrix } from "./Matrix";
import { Runs } from "./Runs";

// The one genuinely hard scenario: where the surface log names a missing
// --config flag but the true cause is a bad command. This is the case the
// headline finding is built on.
const HARD_SCENARIO = "crashloopbackoff-bad-command";

// Format an ISO timestamp as a compact UTC stamp, e.g. "2026-07-10 15:44 UTC".
// Kept deterministic (no locale) so the static build renders identically
// everywhere.
function stamp(iso: string | undefined): string {
  if (!iso) return "unknown";
  const m = iso.match(/^(\d{4}-\d{2}-\d{2})T(\d{2}:\d{2})/);
  return m ? `${m[1]} ${m[2]} UTC` : iso;
}

// The dwm-style status bar: one monospace row of run metadata segments. Scrolls
// horizontally on narrow viewports rather than wrapping, keeping the bar a
// single line the way a tiling-wm bar reads.
function StatusBar({ matrix }: { matrix: MatrixArtifact | null }) {
  return (
    <div className="statusbar" role="banner">
      <div className="statusbar-inner">
        <span className="sb-brand">pod_forensics</span>
        <span className="sb-sep">::</span>
        <span className="sb-seg">model × scenario eval</span>
        {matrix && (
          <>
            <span className="sb-spacer" />
            <span className="sb-seg">
              <span className="sb-k">models</span> {matrix.metadata.models.length}
            </span>
            <span className="sb-dot">·</span>
            <span className="sb-seg">
              <span className="sb-k">N</span> {matrix.metadata.runsPerCell}/cell
            </span>
            <span className="sb-dot">·</span>
            <span className="sb-seg">
              <span className="sb-k">judge</span> {modelLabel(matrix.metadata.judgeModel)}
            </span>
            <span className="sb-dot">·</span>
            <span className="sb-seg">
              <span className="sb-k">est</span> ${matrix.cost.totalUsd.toFixed(2)}
            </span>
            <span className="sb-dot">·</span>
            <span className="sb-seg sb-ro" title="Every tool is read-only; the secret tool returns key names only, never values.">
              read-only
            </span>
          </>
        )}
      </div>
    </div>
  );
}

// The reading aid above the matrix: what the reader is looking at, on what
// data, scored how, with the methodology caveat spelled out.
function Header({ matrix }: { matrix: MatrixArtifact }) {
  const meta = matrix.metadata;
  return (
    <header className="head">
      <div className="eyebrow">agentic k8s root-cause eval</div>
      <h1 className="head-title">
        Which model diagnoses a failing pod, how often, and how sure are we?
      </h1>
      <p className="head-lede">
        The agent is handed a real captured Kubernetes failure and a set of
        read-only diagnostic tools. It reasons — observe, hypothesize, fetch the
        evidence that confirms or refutes — then emits a structured diagnosis.
        Each diagnosis is scored on two independent axes: the observable{" "}
        <em>symptom</em> and the underlying <em>root cause</em>. The matrix below
        is every model against every scenario.
      </p>

      <dl className="head-meta">
        <div>
          <dt>models</dt>
          <dd>{meta.models.map(modelLabel).join(", ")}</dd>
        </div>
        <div>
          <dt>runs / cell</dt>
          <dd>{meta.runsPerCell}</dd>
        </div>
        <div>
          <dt>judge</dt>
          <dd>{modelLabel(meta.judgeModel)}</dd>
        </div>
        <div>
          <dt>captured</dt>
          <dd>{stamp(meta.createdAt)}</dd>
        </div>
      </dl>

      <p className="head-method">
        Each rate carries a <strong>Wilson 95% confidence interval</strong> over
        the cell&apos;s N runs. At low N a point estimate is not a fact: five
        clean runs are still consistent with a true rate well below 1.0, and the
        interval says so. The bars below draw that interval directly — a wide
        bracket means low confidence, not a wide result.
      </p>
    </header>
  );
}

// The headline finding, above the matrix. Read straight from the committed
// cells so the numbers shown are the measurement itself, not a restatement of
// it: cause-identification accuracy on the one hard case, per model, with the
// Wilson interval each carries; the note that the other scenarios are saturated;
// and an honest surfacing of the single failed Opus run.
function Finding({ matrix }: { matrix: MatrixArtifact }) {
  // Per-model cause accuracy on the hard case, in the artifact's model order.
  const hard: MatrixCell[] = matrix.metadata.models
    .map((m) =>
      matrix.cells.find(
        (c) => c.model === m && c.scenarioId === HARD_SCENARIO,
      ),
    )
    .filter((c): c is MatrixCell => !!c);
  if (hard.length === 0) return null;

  // A completion rate below 1 means at least one attempted run produced no valid
  // diagnosis. On this case that is the one Opus run the correction loop rejected.
  const failed = hard.find((c) => c.completionRate < 1);

  return (
    <section className="finding" aria-label="headline finding">
      <div className="eyebrow">headline finding</div>
      <h2 className="finding-title">
        Model scale moves the needle on exactly one case
      </h2>
      <p className="finding-lede">
        On the one genuinely hard scenario — <code>{HARD_SCENARIO}</code>, where
        an application log names a missing <code>--config</code> flag while the
        true cause is a bad container command — cause-identification accuracy
        scales with model size. The other four scenarios sit at or near 100% for
        every model, so this is the one place where model scale matters.
      </p>

      <div className="finding-scale" role="list">
        {hard.map((c) => (
          <div key={c.model} className="fs-cell" role="listitem">
            <span className="fs-model">{modelLabel(c.model)}</span>
            <span className={`fs-val band-${accBand(c.causeAccuracy)}`}>
              {pct(c.causeAccuracy)}
              <span className="metric-unit">%</span>
            </span>
            <span className="fs-ci">
              95% CI [{pct(c.causeAccuracyCI.lower)},{" "}
              {pct(c.causeAccuracyCI.upper)}]
            </span>
          </div>
        ))}
      </div>

      <p className="finding-frame">
        The harness localizes exactly where model scale matters and where it does
        not: four scenarios are saturated for all three models, and only the hard
        case separates them.
      </p>

      {failed && (
        <p className="finding-note">
          One {modelLabel(failed.model)} run on this case failed to produce a
          valid diagnosis (completion rate {pct(failed.completionRate)}%): the
          model leaked tool-call syntax into a diagnosis field value, and the
          validation-and-correction loop rejected the submit. It is counted as a
          failed run, never silently dropped — the completionRate metric and the
          correction loop are doing exactly their job.
        </p>
      )}

      <p className="finding-honest">
        Scenarios were initially grouped by assumed difficulty (obvious vs
        misleading), but measurement showed difficulty is model-dependent, so the
        grouping is descriptive only.
      </p>
    </section>
  );
}

// Shown when the artifact is absent or empty. The build must reach this cleanly,
// never crash, so a fresh clone with no reference run still deploys.
function Placeholder({ report }: { report: RunReport | null }) {
  return (
    <div className="placeholder">
      <div className="ph-prompt">
        <span className="ph-user">agent</span>
        <span className="ph-at">@</span>
        <span className="ph-host">pod_forensics</span>
        <span className="ph-path">~/reports</span>
        <span className="ph-cursor" aria-hidden="true" />
      </div>
      <p className="ph-line">
        <span className="ph-err">reference run not yet generated</span>
      </p>
      <p className="ph-body">
        The showcase matrix reads <code>reports/model-matrix.json</code>, which
        is not present or has no cells. Generate it with <code>pnpm matrix</code>{" "}
        (needs <code>ANTHROPIC_API_KEY</code> and captured fixtures), then commit
        the artifact. The page is a static read of that file, so it rebuilds
        automatically once the artifact exists.
      </p>
      {report && (
        <p className="ph-body ph-muted">
          The deterministic single-model reference run is available below and is
          shown in the meantime.
        </p>
      )}
    </div>
  );
}

export function Console({
  matrix,
  report,
  scenarios,
}: {
  matrix: MatrixArtifact | null;
  report: RunReport | null;
  scenarios: ScenarioMeta[];
}) {
  const scenarioById = new Map(scenarios.map((s) => [s.id, s]));

  return (
    <div className="console">
      <StatusBar matrix={matrix} />

      <main className="page">
        {matrix ? (
          <>
            <Header matrix={matrix} />
            <Finding matrix={matrix} />
            <Matrix matrix={matrix} scenarioById={scenarioById} />
          </>
        ) : (
          <Placeholder report={report} />
        )}

        <Runs report={report} scenarioById={scenarioById} />

        <footer className="foot">
          <p>
            A controlled demonstration of an agentic diagnosis loop and an eval
            method over a finite, known failure taxonomy. Read-only by design;
            not a production SRE tool. Served statically from committed
            artifacts — no cluster, no API key at runtime.
          </p>
        </footer>
      </main>
    </div>
  );
}
