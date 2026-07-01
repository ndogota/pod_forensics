// Capture harness (skeleton).
//
// Offline and local only. This is where fixtures come from: seed a failure
// scenario on a local kind cluster, run every read-only tool against it,
// serialize the outputs to JSON, and commit them. This never runs in
// production, and it never mutates the cluster beyond seeding the scenario
// manifests that define it.
//
// This file is a skeleton. The live cluster calls are TODOs. It already uses
// the shared argsHash so the fixture keys it will write match the keys the
// FixtureProvider reads.

import path from "node:path";

import { argsHash } from "../src/core/tools/argsHash";
import type { ToolCall } from "../src/core/types";

// Where a captured tool result will be written for a scenario.
export function fixturePath(scenarioId: string, call: ToolCall): string {
  const fileName = `${call.tool}-${argsHash(call.args)}.json`;
  return path.resolve(process.cwd(), "src/fixtures", scenarioId, fileName);
}

// Run one read-only tool against the live cluster and return its structured
// output. Not implemented: this is the local-only cluster seam.
async function runToolAgainstCluster(_call: ToolCall): Promise<unknown> {
  // TODO: implement the read-only cluster calls (kubectl-equivalent reads via a
  // Kubernetes client). Each must be read only. get_secret_meta must return key
  // names only, never values, so no secret value ever lands in a fixture.
  throw new Error("local only, not implemented");
}

// TODO: for each seeded scenario:
//   1. Apply its manifests.yaml to a local kind cluster and wait for the
//      failure to manifest.
//   2. For every planned tool call, runToolAgainstCluster and write
//      { capturedAt, output } to fixturePath(scenarioId, call).
//   3. Tear the scenario down.
async function main(): Promise<void> {
  void runToolAgainstCluster;
  void fixturePath;
  throw new Error(
    "capture is a skeleton. The live cluster calls are not implemented yet.",
  );
}

main().catch((err) => {
  console.error(err instanceof Error ? err.message : err);
  process.exit(1);
});
