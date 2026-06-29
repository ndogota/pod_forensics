# reports

Committed eval artifacts. Each run writes a `RunReport` with per-scenario
scores, a confusion matrix over failure classes, and the run traces. The
dashboard reads these statically, so the deployed app needs no cluster and costs
nothing at idle.

Empty for now. Reports are produced by the eval runner in a later quest.
