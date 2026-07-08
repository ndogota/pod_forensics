// Capture harness. Offline and local only.
//
// This is where fixtures come from. Given a scenario id it:
//   1. ensures the scenario namespace exists,
//   2. applies the scenario manifests,
//   3. polls the target pod until the failure manifests,
//   4. resolves the full pod list live from get_pods, expands the scenario's
//      declared read surface into the full set of read-only calls, and runs them
//      through a RecordingProvider wrapping a LiveProvider, materializing one
//      fixture per read, and
//   5. tears the namespace down (unless --keep).
//
// The read surface is exhaustive on purpose. The agent chooses tools freely and
// diagnoses by ruling causes out, so replay must be robust to more than the
// smoking gun: per-pod logs (which may be empty), a probed ConfigMap or Secret
// that does not exist, a Service that has endpoints, and a non-denied RBAC check
// are all recorded, not only the discriminating signal.
//
// It assumes the current kubeconfig context points at a reachable local cluster
// (a kind cluster) and that kubectl is on PATH for the same context. The reads
// that become fixtures go through the real client-node LiveProvider, so a
// captured fixture is exactly what the agent would see live. Seeding and
// teardown are the only mutations, and they touch only this scenario's own
// namespace. It never calls a model.
//
// Usage:
//   pnpm capture --scenario crashloopbackoff-bad-command
//   pnpm capture --scenario crashloopbackoff-bad-command --keep

import { execFileSync } from "node:child_process";
import { rm } from "node:fs/promises";
import path from "node:path";

import { normalizeArgs } from "../src/core/tools/argsHash";
import type { GetPodsOutput } from "../src/core/tools";
import { LiveProvider } from "../src/core/providers/liveProvider";
import { RecordingProvider } from "../src/core/providers/recordingProvider";
import { findCaptureSpec } from "../src/scenarios/captureRegistry";
import { buildReadSurface, type CaptureSpec } from "../src/scenarios/captureSpec";
import { findScenario } from "../src/scenarios";
import type { Scenario } from "../src/core/types";

const TIMEOUT_MS = 180_000;
const POLL_START_MS = 2_000;
const POLL_MAX_MS = 10_000;

interface CliArgs {
  scenario: string;
  keep: boolean;
}

function parseArgs(argv: string[]): CliArgs {
  const args: CliArgs = {
    scenario: "crashloopbackoff-bad-command",
    keep: false,
  };
  for (let i = 0; i < argv.length; i++) {
    const flag = argv[i];
    if (flag === "--scenario") {
      args.scenario = argv[++i];
    } else if (flag === "--keep") {
      args.keep = true;
    } else {
      throw new Error(`unknown argument: ${flag}`);
    }
  }
  return args;
}

function kubectl(args: string[]): string {
  return execFileSync("kubectl", args, { encoding: "utf8" });
}

function ensureNamespace(namespace: string): void {
  try {
    kubectl(["get", "namespace", namespace]);
    console.log(`namespace ${namespace} already exists`);
  } catch {
    console.log(`creating namespace ${namespace}`);
    kubectl(["create", "namespace", namespace]);
  }
}

function applyManifests(scenario: Scenario): void {
  const manifestPath = path.resolve(process.cwd(), scenario.manifestsPath);
  console.log(`applying manifests ${scenario.manifestsPath}`);
  kubectl(["apply", "-n", scenario.namespace, "-f", manifestPath]);
}

function deleteNamespace(namespace: string): void {
  console.log(`deleting namespace ${namespace}`);
  kubectl(["delete", "namespace", namespace, "--wait=false"]);
}

const sleep = (ms: number): Promise<void> =>
  new Promise((resolve) => setTimeout(resolve, ms));

// A container that cannot be pulled never runs, so no wait predicate can ever
// pass. These are the two terminal image-pull waiting reasons the kubelet
// surfaces: ErrImagePull on the first failure, ImagePullBackOff once it backs
// off. Either means the pod is stuck and polling should stop immediately rather
// than burn the full timeout.
const IMAGE_PULL_FAILURE_REASONS = new Set(["ImagePullBackOff", "ErrImagePull"]);

// A pod container stuck waiting on an image pull, with the naming detail needed
// for a clear failure message.
interface ImagePullFailure {
  pod: string;
  container: string;
  reason: string;
  message: string;
}

// Scan the namespace's pods for any container waiting with a terminal image-pull
// reason. Returns the first such container, or null if none. Shared across all
// scenarios: an unpullable image is never the failure under test, so it should
// fail capture fast regardless of scenario.
async function findImagePullFailure(
  provider: LiveProvider,
  namespace: string,
): Promise<ImagePullFailure | null> {
  const podsResult = await provider.resolve({
    tool: "get_pods",
    args: normalizeArgs({ namespace }),
  });
  for (const pod of (podsResult.output as GetPodsOutput).pods) {
    for (const cs of pod.containerStatuses) {
      if (cs.state === "waiting" && cs.reason && IMAGE_PULL_FAILURE_REASONS.has(cs.reason)) {
        return {
          pod: pod.name,
          container: cs.name,
          reason: cs.reason,
          // The kubelet's waiting message names the image, e.g.
          // `Back-off pulling image "rancher/kubectl:v1.30.0"`.
          message: cs.message ?? "",
        };
      }
    }
  }
  return null;
}

// Poll the scenario's own wait predicate through the live provider until its
// failure has manifested, or fail loudly on timeout. The polling loop, the
// bounded timeout, the exponential backoff, and the progress logging are shared
// across all scenarios; only the predicate (spec.poll) is scenario-specific.
// Backoff grows because some failures (CrashLoopBackOff especially) are
// themselves exponential and can take a minute or two to settle. Returns the
// resolved pod name for the captureSet, which may be empty if the scenario needs
// none.
async function waitForFailure(
  provider: LiveProvider,
  scenario: Scenario,
  spec: CaptureSpec,
): Promise<string> {
  const start = Date.now();
  let delay = POLL_START_MS;
  let attempt = 0;
  while (Date.now() - start < TIMEOUT_MS) {
    attempt++;
    const elapsedMs = Date.now() - start;
    const elapsed = Math.round(elapsedMs / 1000);

    // Fail fast on an unpullable image. A container stuck in ImagePullBackOff or
    // ErrImagePull never starts, so the scenario's failure can never manifest and
    // waiting out the timeout would only delay a certain failure. Naming the pod,
    // image, and reason makes the misconfiguration obvious.
    const pullFailure = await findImagePullFailure(provider, scenario.namespace);
    if (pullFailure) {
      throw new Error(
        `image pull failed for "${scenario.id}": pod ${pullFailure.pod} ` +
          `container ${pullFailure.container} is stuck with reason ` +
          `${pullFailure.reason}` +
          (pullFailure.message ? ` (${pullFailure.message})` : "") +
          `. The image cannot be pulled, so the pod will never run. Fix the ` +
          `image in the scenario manifests. Namespace ${scenario.namespace} ` +
          `left in place for inspection.`,
      );
    }

    const result = await spec.poll({ provider, scenario, elapsedMs });
    console.log(`poll ${attempt} (${elapsed}s): ${result.detail}`);
    if (result.done) {
      console.log(
        `failure manifested for "${scenario.id}" after ${elapsed}s` +
          (result.pod ? `: ${result.pod}` : ""),
      );
      return result.pod;
    }
    await sleep(delay);
    delay = Math.min(delay * 1.5, POLL_MAX_MS);
  }
  throw new Error(
    `timed out after ${Math.round(TIMEOUT_MS / 1000)}s waiting for ` +
      `"${scenario.id}" to manifest its failure. Namespace ` +
      `${scenario.namespace} left in place for inspection.`,
  );
}

async function main(): Promise<void> {
  const args = parseArgs(process.argv.slice(2));

  const scenario = findScenario(args.scenario);
  if (!scenario) {
    throw new Error(`unknown scenario: ${args.scenario}`);
  }
  const spec = findCaptureSpec(scenario.id);
  if (!spec) {
    throw new Error(
      `no captureSpec defined for scenario "${scenario.id}". Declare one in its ` +
        `directory and register it in src/scenarios/captureRegistry.ts.`,
    );
  }

  const live = new LiveProvider();

  ensureNamespace(scenario.namespace);
  applyManifests(scenario);

  // On timeout this throws before teardown, so the namespace is left for
  // inspection, as intended.
  const podName = await waitForFailure(live, scenario, spec);

  // Clear any prior fixtures for this scenario so a stale pod-name hash cannot
  // linger. RecordingProvider then recreates the directory as it writes.
  const scenarioFixtures = path.resolve(
    process.cwd(),
    "src/fixtures",
    scenario.id,
  );
  await rm(scenarioFixtures, { recursive: true, force: true });

  // Enumerate every pod in the namespace live, so the read surface covers all of
  // them (describe_pod and both get_logs variants per pod), not just the target.
  // Pod names carry a Deployment's random template suffix, so they are resolved
  // here from get_pods, never hardcoded.
  const podsResult = await live.resolve({
    tool: "get_pods",
    args: normalizeArgs({ namespace: scenario.namespace }),
  });
  const podNames = (podsResult.output as GetPodsOutput).pods.map((p) => p.name);
  console.log(
    `namespace ${scenario.namespace} has ${podNames.length} pod(s): ` +
      (podNames.join(", ") || "(none)"),
  );

  const recorder = new RecordingProvider(live, scenario.id);
  const readSurface = buildReadSurface(
    scenario.namespace,
    spec.surface,
    podNames,
  );
  console.log(`recording ${readSurface.length} fixtures for ${scenario.id}`);
  let recorded = 0;
  for (const call of readSurface) {
    try {
      await recorder.resolve(call);
      recorded++;
      console.log(`  wrote ${call.tool} (${JSON.stringify(call.args)})`);
    } catch (err) {
      // One failing read must not abort the exhaustive capture. Expected API
      // errors no longer land here: the LiveProvider encodes a Status with an HTTP
      // code (a 400 for previous logs on a container that never restarted, a 403
      // for an RBAC-denied read) into a normal { apiError } ToolResult, which is
      // recorded like any other fixture. Only a genuine unexpected failure
      // (network, unreachable API server, cluster auth) reaches this catch. Log it
      // and continue; the agent sees an uncaptured result for that one call at
      // replay.
      console.warn(
        `  skipped ${call.tool} (${JSON.stringify(call.args)}): ` +
          (err instanceof Error ? err.message : String(err)),
      );
    }
  }
  console.log(
    `recorded ${recorded}/${readSurface.length} fixtures for ${scenario.id}`,
  );

  if (podName) {
    console.log(`captured pod name: ${podName}`);
    console.log(
      `if this differs from the fake client's pod constant for "${scenario.id}", ` +
        "update it so the deterministic replay hits these same fixture hashes.",
    );
  }

  if (args.keep) {
    console.log(`--keep set, leaving namespace ${scenario.namespace} in place`);
  } else {
    deleteNamespace(scenario.namespace);
  }

  console.log("capture complete");
}

main().catch((err) => {
  console.error(err instanceof Error ? err.message : err);
  process.exit(1);
});
