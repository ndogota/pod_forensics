// Capture harness. Offline and local only.
//
// This is where fixtures come from. Given a scenario id it:
//   1. ensures the scenario namespace exists,
//   2. applies the scenario manifests,
//   3. polls the target pod until the failure manifests,
//   4. runs the scenario captureSet through a RecordingProvider wrapping a
//      LiveProvider, materializing one fixture per read, and
//   5. tears the namespace down (unless --keep).
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

import { LiveProvider } from "../src/core/providers/liveProvider";
import { RecordingProvider } from "../src/core/providers/recordingProvider";
import type { GetPodsOutput } from "../src/core/tools";
import { buildCaptureSet } from "../src/scenarios/crashloopbackoff-bad-command/captureSet";
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

// Find the pod created by the target workload. A Deployment names its pods with
// a template hash suffix, so match on the workload name prefix.
function findTargetPod(pods: GetPodsOutput, targetName: string) {
  return pods.pods.find((p) => p.name.startsWith(`${targetName}-`));
}

// The failure is "manifested" once a container is waiting in CrashLoopBackOff or
// has restarted enough times that the loop is unambiguous.
function crashLoopReached(pod: ReturnType<typeof findTargetPod>): boolean {
  if (!pod) return false;
  return pod.containerStatuses.some(
    (c) => c.reason === "CrashLoopBackOff" || c.restartCount >= 3,
  );
}

// Poll get_pods through the live provider until the target pod is in the failure
// state, or fail loudly on timeout. Backoff grows because CrashLoopBackOff is
// itself exponential and can take a minute or two to settle.
async function waitForCrashLoop(
  provider: LiveProvider,
  scenario: Scenario,
): Promise<string> {
  const start = Date.now();
  let delay = POLL_START_MS;
  let attempt = 0;
  while (Date.now() - start < TIMEOUT_MS) {
    attempt++;
    const elapsed = Math.round((Date.now() - start) / 1000);
    const result = await provider.resolve({
      tool: "get_pods",
      args: { namespace: scenario.namespace },
    });
    const pod = findTargetPod(result.output as GetPodsOutput, scenario.target.name);
    if (pod) {
      const status = pod.containerStatuses[0];
      console.log(
        `poll ${attempt} (${elapsed}s): pod ${pod.name} phase=${pod.phase} ` +
          `restarts=${pod.restarts} reason=${status?.reason ?? "-"}`,
      );
      if (crashLoopReached(pod)) {
        console.log(`CrashLoopBackOff reached after ${elapsed}s: ${pod.name}`);
        return pod.name;
      }
    } else {
      console.log(`poll ${attempt} (${elapsed}s): target pod not scheduled yet`);
    }
    await sleep(delay);
    delay = Math.min(delay * 1.5, POLL_MAX_MS);
  }
  throw new Error(
    `timed out after ${Math.round(TIMEOUT_MS / 1000)}s waiting for ` +
      `${scenario.target.name} to reach CrashLoopBackOff. Namespace ` +
      `${scenario.namespace} left in place for inspection.`,
  );
}

async function main(): Promise<void> {
  const args = parseArgs(process.argv.slice(2));

  const scenario = findScenario(args.scenario);
  if (!scenario) {
    throw new Error(`unknown scenario: ${args.scenario}`);
  }
  if (scenario.id !== "crashloopbackoff-bad-command") {
    throw new Error(
      `no captureSet defined for scenario "${scenario.id}". Only ` +
        `crashloopbackoff-bad-command is wired for capture in this run.`,
    );
  }

  const live = new LiveProvider();

  ensureNamespace(scenario.namespace);
  applyManifests(scenario);

  // On timeout this throws before teardown, so the namespace is left for
  // inspection, as intended.
  const podName = await waitForCrashLoop(live, scenario);

  // Clear any prior fixtures for this scenario so a stale pod-name hash cannot
  // linger. RecordingProvider then recreates the directory as it writes.
  const scenarioFixtures = path.resolve(
    process.cwd(),
    "src/fixtures",
    scenario.id,
  );
  await rm(scenarioFixtures, { recursive: true, force: true });

  const recorder = new RecordingProvider(live, scenario.id);
  const captureSet = buildCaptureSet(scenario.namespace, podName);
  console.log(`recording ${captureSet.length} fixtures for ${scenario.id}`);
  for (const call of captureSet) {
    const result = await recorder.resolve(call);
    console.log(`  wrote ${call.tool} (${JSON.stringify(call.args)})`);
    void result;
  }

  console.log(`captured pod name: ${podName}`);
  console.log(
    "if this differs from the fake client's CRASHLOOP_POD, update it so the " +
      "deterministic replay hits these same fixture hashes.",
  );

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
