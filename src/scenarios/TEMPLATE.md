# Adding a scenario

A scenario is data. To add one:

1. Create a directory `src/scenarios/<scenario-id>/` with:
   - `manifests.yaml` — the broken Kubernetes manifests. This is data for the
     offline capture step. It is never applied by the agent or the eval.
   - `groundtruth.json` — a `GroundTruth` object with two orthogonal, separately
     scored labels: `symptom` (the observable pod or service state, from the
     `Symptom` set) and `rootCauseClass` (the underlying cause, from the
     `RootCauseClass` set, which may differ from the symptom). Set each to the
     real mechanism, not to what a log message suggests: if a crash prints a
     "missing --config" line but the true cause is a bad command, the
     `rootCauseClass` is `BadCommand`, not `MissingConfigOrSecret`. Also include a
     canonical `rootCause` in plain language and an `expectedEvidence` list of
     short signal strings.

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

## Seeded so far

Five scenarios are seeded: four at the obvious tier and one at the misleading
tier. Each is labelled with a symptom and a root-cause class (symptom /
rootCauseClass):

Obvious tier:

- CrashLoopBackOff / BadCommand — a bad container command that exits non-zero.
  The container's log mentions a missing --config flag, which looks like a decoy
  toward MissingConfigOrSecret, but an 8-run measurement showed the agent scores
  causeAccuracy 1.00 here: it reasons past the log string, so this is an honest
  obvious case, not a trap.
- Pending / InsufficientResources — a memory request no node can satisfy
- ServiceNoEndpoints / SelectorLabelMismatch — a selector that does not match
  pod labels
- RunningDegraded / RbacDenied — a ServiceAccount bound to no Role (checked with
  a SubjectAccessReview against the workload identity); the pod runs but is
  degraded because its API calls are forbidden

Misleading tier:

- Pending / MissingConfigOrSecret (configmap-volume-missing) — a pod mounts a
  ConfigMap as a volume where the referenced ConfigMap does not exist, so the pod
  is stuck in ContainerCreating (phase Pending) with a FailedMount event. The
  not-running symptom reads like a generic scheduling or startup fault; the
  discriminating move is to read the FailedMount event that names the ConfigMap
  and probe get_configmap to see it absent, which pins the cause to
  MissingConfigOrSecret.

Each has a directory (manifests, groundtruth, captureSet+captureSpec), an entry
in `index.ts`, a `CaptureSpec` in `captureRegistry.ts`, and a FakeModelClient
script wired into `FAKE_SCRIPTS` in `scripts/eval.ts`.

## Still to seed (TODO)

Per the architecture doc, six more scenarios remain: four more at the obvious
tier (one per remaining failure class) and two at the misleading tier, where the
obvious surface signal is a symptom of a different root cause.

- ImagePullBackOff from a wrong image tag (obvious)
- OOMKilled from a memory limit set too low (obvious)
- ProbeMisconfigured from a readiness probe on the wrong port (obvious)
- ServiceNoEndpoints whose true cause is that the backing pods are all
  unschedulable, class PodUnschedulable (misleading)

The "volume referencing a missing ConfigMap" mechanism is already seeded, but at
the misleading tier (configmap-volume-missing above) rather than the obvious
tier the original taxonomy slotted it in: the not-running symptom is a genuine
trap. A separate obvious MissingConfigOrSecret scenario, if wanted, should use a
distinct mechanism (for example an envFrom configMapRef) so it does not duplicate
this one.

Each will also need a `CaptureSpec`, a FakeModelClient script (or a switch to
AnthropicModelClient), and the two misleading-tier entries carry `tier:
"misleading"`. These are intentionally left as TODOs.
