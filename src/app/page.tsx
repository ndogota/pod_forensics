import { readFile } from "node:fs/promises";
import path from "node:path";

import type { RunReport } from "../core/types";
import { SCENARIOS } from "../scenarios";
import type { MatrixArtifact, ScenarioMeta } from "./lib/matrix";
import { Console } from "./components/Console";

// Both artifacts are read once, at build time, from the committed reports
// directory. Every read is guarded: a missing or malformed file resolves to
// null so the static build never fails on a not-yet-generated artifact. The
// matrix is the headline; the deterministic run-report is a secondary view.
async function loadJson<T>(relPath: string): Promise<T | null> {
  const abs = path.resolve(process.cwd(), relPath);
  try {
    const raw = await readFile(abs, "utf8");
    return JSON.parse(raw) as T;
  } catch {
    return null;
  }
}

// A valid, renderable matrix has at least one cell. Anything less is treated as
// "not yet generated" and degrades to the placeholder.
function matrixIsRenderable(m: MatrixArtifact | null): m is MatrixArtifact {
  return !!m && Array.isArray(m.cells) && m.cells.length > 0;
}

// Human-facing scenario metadata, threaded in from the registry so the client
// bundle carries no domain code. The dashboard falls back to the raw id for any
// scenario the matrix names that the registry does not.
function scenarioMeta(): ScenarioMeta[] {
  return SCENARIOS.map((s) => ({
    id: s.id,
    description: s.description,
    tier: s.tier,
  }));
}

export default async function HomePage() {
  const [matrix, report] = await Promise.all([
    loadJson<MatrixArtifact>("reports/model-matrix.json"),
    loadJson<RunReport>("reports/run-report.json"),
  ]);

  return (
    <Console
      matrix={matrixIsRenderable(matrix) ? matrix : null}
      report={report}
      scenarios={scenarioMeta()}
    />
  );
}
