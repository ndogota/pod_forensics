# scenarios

Data as code for each seeded failure. One directory per scenario:

```
<scenario-id>/
  manifests.yaml     broken Kubernetes manifests (data for capture only)
  groundtruth.json   the GroundTruth labels (symptom, rootCauseClass, rootCause, evidence)
  captureSet.ts      the wait predicate + read-only calls to record as fixtures
```

The scenario's `namespace`, `target`, and `tier` live in the registry entry in
`index.ts`, not in `groundtruth.json`, since they are `Scenario` fields. The
`captureSet.ts` exports a `CaptureSpec` registered in `captureRegistry.ts`.

Four obvious-tier scenarios are seeded so far, each labelled with an orthogonal
symptom and root-cause class: `crashloopbackoff-bad-command`,
`pod-unschedulable`, `service-no-endpoints`, and `rbac-denied`. Ten scenarios are
planned in total: eight at the obvious tier and two at the misleading tier where
the observable symptom points at the wrong root cause. See `TEMPLATE.md` for what
remains.
