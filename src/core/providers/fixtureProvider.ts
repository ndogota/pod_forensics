// FixtureProvider resolves tool calls to captured JSON.
//
// Used in eval and in the deployed demo. It reads frozen inputs from
// src/fixtures/<scenarioId>/<tool>-<argshash>.json so runs are reproducible and
// the demo needs no live cluster.
//
// This quest implements path resolution and read only. No fixtures exist yet,
// so resolve throws a clear not-found error pointing at the path it looked for.

import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import path from "node:path";

import { toolDefinitions } from "../tools";
import type {
  ToolCall,
  ToolDefinition,
  ToolProvider,
  ToolResult,
} from "../types";

// Default fixtures root, relative to the process working directory. Capture and
// eval run from the project root.
// TODO: make the base directory robust to the working directory once the
// capture and eval harnesses exist.
const DEFAULT_FIXTURES_ROOT = path.resolve(process.cwd(), "src/fixtures");

// Stable short hash of tool arguments. Keys are sorted so the hash does not
// depend on insertion order.
export function argsHash(args: Record<string, string>): string {
  const canonical = JSON.stringify(
    Object.keys(args)
      .sort()
      .map((k) => [k, args[k]]),
  );
  return createHash("sha1").update(canonical).digest("hex").slice(0, 8);
}

export class FixtureProvider implements ToolProvider {
  private readonly scenarioId: string;
  private readonly fixturesRoot: string;

  constructor(scenarioId: string, fixturesRoot: string = DEFAULT_FIXTURES_ROOT) {
    this.scenarioId = scenarioId;
    this.fixturesRoot = fixturesRoot;
  }

  listTools(): ToolDefinition[] {
    return toolDefinitions;
  }

  // Resolve the on-disk path for a tool call without reading it.
  fixturePath(call: ToolCall): string {
    const fileName = `${call.tool}-${argsHash(call.args)}.json`;
    return path.join(this.fixturesRoot, this.scenarioId, fileName);
  }

  async resolve(call: ToolCall): Promise<ToolResult> {
    const filePath = this.fixturePath(call);

    let raw: string;
    try {
      raw = await readFile(filePath, "utf8");
    } catch (err) {
      const reason = (err as NodeJS.ErrnoException)?.code ?? String(err);
      throw new Error(
        `fixture not found for tool "${call.tool}" in scenario "${this.scenarioId}". ` +
          `Looked for ${filePath} (${reason}). No fixtures have been captured yet.`,
      );
    }

    const parsed = JSON.parse(raw) as {
      output: unknown;
      capturedAt?: string;
    };

    return {
      tool: call.tool,
      args: call.args,
      output: parsed.output,
      capturedAt: parsed.capturedAt,
    };
  }
}
