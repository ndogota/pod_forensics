// Single source of truth for the fixture argshash.
//
// A tool call resolves to exactly one fixture file named
// <tool>-<argshash>.json. Both the FixtureProvider (read side) and the capture
// harness (write side) must derive that hash the same way, so the logic lives
// here and nowhere else. Do not inline hashing anywhere.
//
// The hash normalizes the call arguments by sorting keys and stringifying the
// result in a stable order, so it does not depend on argument insertion order.

import { createHash } from "node:crypto";

// Convert a model tool call's raw arguments into the canonical
// Record<string, string> that a ToolCall carries. Values (booleans, numbers)
// are stringified and keys are sorted. This is the ONE place args are
// normalized: the same normalized object is what argsHash hashes and what
// ToolProvider.resolve receives. No tool-specific coercion lives anywhere else.
export function normalizeArgs(
  input: Record<string, unknown>,
): Record<string, string> {
  const out: Record<string, string> = {};
  for (const key of Object.keys(input).sort()) {
    const value = input[key];
    if (value === undefined || value === null) continue;
    out[key] = String(value);
  }
  return out;
}

export function argsHash(args: Record<string, string>): string {
  const canonical = JSON.stringify(
    Object.keys(args)
      .sort()
      .map((k) => [k, args[k]]),
  );
  return createHash("sha1").update(canonical).digest("hex").slice(0, 8);
}
