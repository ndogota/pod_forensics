// Canonical shaping of a tool call's arguments.
//
// A freely-exploring agent calls the same tool with varying optional arguments:
// get_logs with or without `previous`, with or without an explicit `container`.
// Left alone, each variant hashes to a different fixture key and misses the file
// capture wrote. This is the single place that shapes a raw tool call's arguments
// into the canonical Record<string, string> a ToolCall carries, so that every
// variant of a call converges on one key. Both the fixture-key derivation (read
// side) and the capture routine (write side) run their args through here, so
// capture and replay produce identical keys by construction.
//
// The shaping rules, applied in order:
//   1. Drop arguments that are empty or not declared in the tool's input schema.
//   2. Drop optional arguments the fixtures never vary on (get_logs.container:
//      all seeded scenarios are single-container pods, so the sole container is
//      implied and an explicit container name must not fork the key).
//   3. Fill declared optional arguments with their default when absent
//      (get_logs.previous defaults to "false": an agent that has not yet learned
//      a pod crashed reads logs without `previous`, and that must converge on the
//      same key as an explicit previous=false).
//   4. Apply normalizeArgs (sorted keys, stringified values) for the final shape.
//
// This is the only per-tool argument shaping in the codebase. normalizeArgs stays
// a lower-level primitive (stringify + sort) that this function finishes with; no
// other tool-specific coercion lives anywhere else.

import { z } from "zod";

import { normalizeArgs } from "./argsHash";
import { argsHash } from "./argsHash";
import { toolInputSchemas } from "./index";
import type { ToolCall } from "../types";

// Declared argument names per tool, derived once from the tools' zod input
// schemas. An argument not present here for its tool is dropped: it is not part
// of the tool's contract and would only fork the fixture key.
const DECLARED_KEYS: Record<string, Set<string>> = Object.fromEntries(
  Object.entries(toolInputSchemas).map(([name, schema]) => {
    const json = z.toJSONSchema(schema) as {
      properties?: Record<string, unknown>;
    };
    return [name, new Set(Object.keys(json.properties ?? {}))];
  }),
);

// Declared defaults for optional arguments, filled when the caller omits them.
// Only get_logs.previous has one; see the header note for why.
const TOOL_ARG_DEFAULTS: Record<string, Record<string, string>> = {
  get_logs: { previous: "false" },
};

// Optional arguments dropped entirely rather than defaulted, because the
// fixtures do not vary on them. All seeded scenarios are single-container pods,
// so a get_logs container name is implied by the pod; dropping it makes calls
// with or without an explicit container converge on the same key.
const TOOL_ARG_DROP: Record<string, Set<string>> = {
  get_logs: new Set(["container"]),
};

export function canonicalizeToolArgs(
  toolName: string,
  args: Record<string, unknown>,
): Record<string, string> {
  const declared = DECLARED_KEYS[toolName];
  const drop = TOOL_ARG_DROP[toolName];
  const shaped: Record<string, unknown> = {};

  for (const [key, value] of Object.entries(args)) {
    // Empty, absent, or dropped values carry no signal and must not fork the key.
    if (value === undefined || value === null || value === "") continue;
    if (drop?.has(key)) continue;
    // Drop anything outside the tool's declared contract. An unknown tool has no
    // declared set; pass its args through unfiltered rather than erasing them.
    if (declared && !declared.has(key)) continue;
    shaped[key] = value;
  }

  const defaults = TOOL_ARG_DEFAULTS[toolName];
  if (defaults) {
    for (const [key, def] of Object.entries(defaults)) {
      if (shaped[key] === undefined && !drop?.has(key)) {
        shaped[key] = def;
      }
    }
  }

  return normalizeArgs(shaped);
}

// The fixture filename stem for a call: <tool>-<hash>. Both the FixtureProvider
// (read) and the RecordingProvider (write) route through here, so a call's args
// are canonicalized before hashing no matter how they arrived. Canonicalization
// is idempotent, so re-canonicalizing an already-canonical ToolCall is a no-op.
export function fixtureKey(call: ToolCall): string {
  return argsHash(canonicalizeToolArgs(call.tool, call.args));
}
