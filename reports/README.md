# reports

Committed eval artifacts. Each run writes a `RunReport` with per-scenario
scores, a confusion matrix over root-cause classes, and the run traces. The
dashboard reads these statically, so the deployed app needs no cluster and costs
nothing at idle.

`run-report.json` is the committed deterministic artifact. It is produced by
`pnpm eval` with the default FakeModelClient, which scripts a valid one-shot
diagnosis per scenario, so the report is reproducible and needs no cluster or API
key. It currently covers the four seeded scenarios.

The FakeModelClient is scripted and does not read fixtures to decide its answer,
so this report demonstrates the scoring machinery over the taxonomy. Real
evidence fidelity comes from the uncommitted `--client anthropic` run, which
reads captured fixtures. Capture those locally with `pnpm capture --scenario
<id>` before running the Anthropic eval.
