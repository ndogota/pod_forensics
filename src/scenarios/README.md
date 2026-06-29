# scenarios

Data as code for each seeded failure. One directory per scenario:

```
<scenario-id>/
  manifests.yaml     broken Kubernetes manifests
  groundtruth.json   the GroundTruth label and a difficulty tier
```

Empty for now. Ten scenarios will be seeded in a later quest: eight at the
obvious tier, one per failure class, and two at the misleading tier where the
obvious surface signal points at the wrong root cause.
