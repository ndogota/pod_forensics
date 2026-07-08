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

// Stringify and sort a call's arguments into a stable Record<string, string>.
// Values (booleans, numbers) are stringified and keys are sorted, so the result
// is independent of insertion order. This is a low-level primitive: it does no
// tool-specific shaping. canonicalizeToolArgs (see ./canonicalizeToolArgs) is the
// single place that shapes a tool call's args (fills optional defaults, drops
// non-varying options) and finishes by calling this. Callers that build a
// ToolCall go through canonicalizeToolArgs, not this directly.
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
