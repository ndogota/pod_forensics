# reports

Committed eval artifacts. The dashboard reads these statically at build time, so
the deployed app needs no cluster, no server, and no API key and costs nothing at
idle. See `../DEPLOY.md` for the build and deploy flow.

`model-matrix.json` is the showcase artifact and the dashboard headline. It holds
one cell per (model, scenario) pair with symptom and cause accuracy, completion
rate, and evidence recall, each carrying a Wilson 95% confidence interval over
the cell's N runs, plus the root-cause judge mean and per-model cost. Regenerate
it with `pnpm matrix` (needs `ANTHROPIC_API_KEY` and captured fixtures), then
commit it. The dashboard is a static read of this file; if it is absent, the page
renders a placeholder rather than failing to build.

`run-report.json` is the secondary single-model view. Each run writes a
`RunReport` with per-scenario scores, a confusion matrix over root-cause classes,
and the run traces.

`run-report.json` is the committed deterministic artifact. It is produced by
`pnpm eval` with the default FakeModelClient, which scripts a valid one-shot
diagnosis per scenario, so the report is reproducible and needs no cluster or API
key. It currently covers the four seeded scenarios.

The FakeModelClient is scripted and does not read fixtures to decide its answer,
so this report demonstrates the scoring machinery over the taxonomy. Real
evidence fidelity comes from the uncommitted `--client anthropic` run, which
reads captured fixtures. Capture those locally with `pnpm capture --scenario
<id>` before running the Anthropic eval.
