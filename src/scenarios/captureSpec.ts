// The per-scenario capture contract.
//
// Each scenario declares HOW its failure manifests (the wait predicate) and
// WHICH read-only tool calls become fixtures (the captureSet). This lives beside
// the scenario data, not on the frozen Scenario type in core/types, so scenario
// identity stays untouched.
//
// The capture harness (scripts/capture.ts) owns the polling loop: the timeout,
// the exponential backoff, and the progress logging are shared across all
// scenarios. Each scenario only supplies a `poll` predicate that inspects the
// live cluster through read-only tools and reports whether its failure has
// manifested yet. This keeps capture read-only and model-free: `poll` may only
// call ToolProvider.resolve, which resolves to reads.

import type { Scenario, ToolCall, ToolProvider } from "../core/types";

// Everything a scenario's wait predicate needs for one poll attempt. elapsedMs
// is provided so a predicate can express a "past a grace period" condition
// without reading the clock itself (the harness owns the clock).
export interface PollContext {
  provider: ToolProvider;
  scenario: Scenario;
  elapsedMs: number;
}

// The outcome of one poll attempt.
export interface PollResult {
  // True once the scenario's failure has manifested and fixtures can be taken.
  done: boolean;
  // The resolved pod name for the captureSet. A Deployment names its pods with a
  // template hash suffix not known until the pod exists, so the predicate
  // resolves it live. Empty string when the captureSet needs no pod name.
  pod: string;
  // A one-line human-readable progress string the harness logs each attempt.
  detail: string;
}

export interface CaptureSpec {
  // Wait predicate. Called once per poll attempt by the harness. It may only
  // issue read-only tool calls through ctx.provider.
  poll(ctx: PollContext): Promise<PollResult>;
  // The read-only tool calls to record as fixtures once poll reports done. The
  // resolved pod name is threaded in so calls that take a pod hash to the same
  // fixture key the FixtureProvider computes on replay.
  buildCaptureSet(namespace: string, pod: string): ToolCall[];
}

// Find the pod created by a workload. A Deployment names its pods with a
// template hash suffix, so match on the workload name prefix. Shared by the
// scenario predicates.
export function findPodByPrefix<T extends { name: string }>(
  pods: T[],
  workloadName: string,
): T | undefined {
  return pods.find((p) => p.name.startsWith(`${workloadName}-`));
}
