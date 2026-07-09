import { readFile } from "node:fs/promises";
import path from "node:path";

import type { RunReport } from "../core/types";

async function loadReport(): Promise<RunReport | null> {
  const reportPath = path.resolve(process.cwd(), "reports/run-report.json");
  try {
    const raw = await readFile(reportPath, "utf8");
    return JSON.parse(raw) as RunReport;
  } catch {
    return null;
  }
}

function Intro() {
  return (
    <header>
      <h1>pod_forensics</h1>
      <p>
        An experimental tool. An agent uses read-only diagnostic tools to form a
        root cause hypothesis for a failing Kubernetes workload, then each
        diagnosis is scored against known ground truth. This is a controlled
        demonstration of an agentic diagnosis loop and an eval methodology over a
        finite failure taxonomy. It is not a production SRE tool.
      </p>
      <p className="note">
        Read only by design. The tools never change anything, and the secret
        tool returns key names only, never values.
      </p>
    </header>
  );
}

export default async function HomePage() {
  const report = await loadReport();

  if (!report) {
    return (
      <main>
        <Intro />
        <p>
          No run report yet. Generate one with <code>pnpm eval</code>, which
          writes <code>reports/run-report.json</code>.
        </p>
      </main>
    );
  }

  const { byTier } = report;

  return (
    <main>
      <Intro />

      <section>
        <h2>Cause accuracy by tier</h2>
        <p className="note">
          The obvious tier has a plain surface signal. The misleading tier hides a
          decoy signal that points at the wrong cause. The gap between them is the
          headline number: it measures whether the agent reasons about the cause
          or pattern-matches what it sees.
        </p>

        {byTier.causeAccuracyGap !== null ? (
          <p className="headline">
            <span className="headline-number">
              {byTier.causeAccuracyGap.toFixed(2)}
            </span>
            <span className="headline-label">
              cause-accuracy gap (obvious minus misleading)
            </span>
          </p>
        ) : (
          <p className="meta">
            Gap not shown: both the obvious and misleading tiers must be present.
          </p>
        )}

        <div className="tier-grid">
          {byTier.tiers.map((t) => (
            <div key={t.tier} className="tier-card">
              <h3>{t.tier}</h3>
              <p className="meta">{t.scenarioCount} scenario(s)</p>
              <dl className="tier-metrics">
                <div>
                  <dt>cause accuracy</dt>
                  <dd className="lead">{t.causeAccuracy.toFixed(2)}</dd>
                </div>
                <div>
                  <dt>symptom accuracy</dt>
                  <dd>{t.symptomAccuracy.toFixed(2)}</dd>
                </div>
                <div>
                  <dt>completion rate</dt>
                  <dd>{t.completionRate.toFixed(2)}</dd>
                </div>
                <div>
                  <dt>evidence recall</dt>
                  <dd>{t.evidenceRecall.toFixed(2)}</dd>
                </div>
                <div>
                  <dt>root cause judge</dt>
                  <dd>{t.rootCauseJudge.toFixed(2)}</dd>
                </div>
              </dl>
            </div>
          ))}
        </div>
      </section>

      <section>
        <h2>Eval summary</h2>
        <p className="meta">
          model <code>{report.model}</code>, created {report.createdAt}
        </p>
        <table>
          <thead>
            <tr>
              <th>scenario</th>
              <th>tier</th>
              <th>runs</th>
              <th>completion rate</th>
              <th>symptom accuracy</th>
              <th>cause accuracy</th>
              <th>evidence recall</th>
              <th>root cause judge</th>
            </tr>
          </thead>
          <tbody>
            {report.scenarioScores.map((s) => (
              <tr key={s.scenarioId}>
                <td>{s.scenarioId}</td>
                <td>{s.tier}</td>
                <td>{s.runs}</td>
                <td>{s.completionRate.toFixed(2)}</td>
                <td>{s.symptomAccuracy.toFixed(2)}</td>
                <td>{s.causeAccuracy.toFixed(2)}</td>
                <td>{s.evidenceRecall.toFixed(2)}</td>
                <td>{s.rootCauseJudgeScore.toFixed(2)}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </section>

      <section>
        <h2>Runs</h2>
        {report.traces.map((trace, i) => (
          <article key={i} className="run">
            <h3>
              {trace.scenarioId} <span className="meta">run {i + 1}</span>
            </h3>

            <div className="diagnosis">
              <p>
                <strong>{trace.diagnosis.rootCauseClass}</strong>{" "}
                <span className="meta">
                  symptom {trace.diagnosis.symptom}, confidence{" "}
                  {trace.diagnosis.confidence.toFixed(2)}
                </span>
              </p>
              <p>{trace.diagnosis.rootCause}</p>
              <p className="fix">
                <strong>Suggested fix (advice only):</strong>{" "}
                {trace.diagnosis.suggestedFix}
              </p>
            </div>

            <h4>Cited evidence</h4>
            <ul className="evidence">
              {trace.diagnosis.evidence.map((e, j) => (
                <li key={j}>
                  <code>
                    {e.tool}({formatArgs(e.args)})
                  </code>
                  <div>{e.excerpt}</div>
                </li>
              ))}
            </ul>

            <h4>Step trace</h4>
            <table>
              <thead>
                <tr>
                  <th>#</th>
                  <th>tool</th>
                  <th>args</th>
                  <th>latency ms</th>
                  <th>tokens in</th>
                  <th>tokens out</th>
                </tr>
              </thead>
              <tbody>
                {trace.steps.map((step) => (
                  <tr key={step.index}>
                    <td>{step.index}</td>
                    <td>
                      <code>{step.toolCall.tool}</code>
                    </td>
                    <td>
                      <code>{formatArgs(step.toolCall.args)}</code>
                    </td>
                    <td>{step.latencyMs}</td>
                    <td>{step.tokensIn}</td>
                    <td>{step.tokensOut}</td>
                  </tr>
                ))}
              </tbody>
            </table>
            <p className="meta">
              {trace.stepCount} steps, {trace.totalTokens} tokens, cost $
              {trace.costUsd.toFixed(4)}, {trace.totalLatencyMs} ms
            </p>
          </article>
        ))}
      </section>
    </main>
  );
}

function formatArgs(args: Record<string, string>): string {
  return Object.entries(args)
    .map(([k, v]) => `${k}: ${v}`)
    .join(", ");
}
