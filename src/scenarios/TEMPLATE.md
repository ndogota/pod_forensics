# Adding a scenario

A scenario is data. To add one:

1. Create a directory `src/scenarios/<scenario-id>/` with:
   - `manifests.yaml` — the broken Kubernetes manifests. This is data for the
     offline capture step. It is never applied by the agent or the eval.
   - `groundtruth.json` — a `GroundTruth` object: the `failureClass` from the
     closed set, a canonical `rootCause` in plain language, and an
     `expectedEvidence` list of short signal strings.

2. Make sure each `expectedEvidence` marker actually appears in the captured
   fixtures for that scenario, so evidence recall measures something real.

   Each marker must be a discriminating signal: a substring that this specific
   failure produces and that a healthy workload, or one failing a different way,
   would not. Never use a field name (for example `exitCode`), and never use a
   token that shows up regardless of the failure (a terminated container always
   has an `exitCode` field, so it discriminates nothing). Prefer the signal that
   names the cause, such as the crash log line or the specific waiting reason. If
   the only distinguishing signal is a structured field value that has no clean
   discriminating substring (such as a non-zero exit code), leave it out rather
   than adding a weak marker; scoring it well needs structured-field assertions,
   which the scorer does not yet support.

3. Register it in `src/scenarios/index.ts` by adding a `Scenario` entry with the
   metadata, including `namespace` and `target` (the workload kind and name).
   The failing pod name, when it differs from the target, is a fixture detail
   that lives with that scenario's FakeModelClient script.

4. Capture fixtures under `src/fixtures/<scenario-id>/` named
   `<tool>-<argshash>.json`, where the hash comes from the shared
   `argsHash` function. Each file holds `{ capturedAt, output }`.

## Still to seed

Per the architecture doc, nine more scenarios remain: seven more at the obvious
tier (one per remaining failure class) and two at the misleading tier, where the
obvious surface signal is a symptom of a different root cause.

- ImagePullBackOff from a wrong image tag (obvious)
- OOMKilled from a memory limit set too low (obvious)
- ProbeMisconfigured from a readiness probe on the wrong port (obvious)
- PodUnschedulable from a resource request no node can satisfy (obvious)
- ServiceNoEndpoints from a selector that does not match pod labels (obvious)
- MissingConfigOrSecret from a volume referencing a missing ConfigMap (obvious)
- RbacDenied from a ServiceAccount lacking the required role (obvious)
- CrashLoopBackOff whose true cause is a missing ConfigMap at startup, class
  MissingConfigOrSecret (misleading)
- ServiceNoEndpoints whose true cause is that the backing pods are all
  unschedulable, class PodUnschedulable (misleading)

Each will also need a FakeModelClient script, or a switch to
AnthropicModelClient, so the eval can run against it.
