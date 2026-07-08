// FixtureProvider resolves tool calls to captured JSON.
//
// Used in eval and in the deployed demo. It reads frozen inputs from
// src/fixtures/<scenarioId>/<tool>-<argshash>.json so runs are reproducible and
// the demo needs no live cluster.
//
// A missing fixture is a coverage gap, not a fatal error. By default resolve does
// not throw: it logs a loud one-line MISS (scenarioId, tool, argshash) so the gap
// is visible, and returns a structured ToolResult marked as uncaptured. The agent
// sees a normal empty result and keeps investigating instead of derailing. Strict
// mode (off by default) restores the throw, for capture-time integrity checks.

import { readFile } from "node:fs/promises";
import path from "node:path";

import { argsHash } from "../tools/argsHash";
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

export class FixtureProvider implements ToolProvider {
  private readonly scenarioId: string;
  private readonly fixturesRoot: string;
  // When true, a missing fixture throws instead of returning an uncaptured
  // result. Off by default; capture-time integrity checks turn it on.
  private readonly strict: boolean;

  constructor(
    scenarioId: string,
    fixturesRoot: string = DEFAULT_FIXTURES_ROOT,
    strict: boolean = false,
  ) {
    this.scenarioId = scenarioId;
    this.fixturesRoot = fixturesRoot;
    this.strict = strict;
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
      if (this.strict) {
        throw new Error(
          `fixture not found for tool "${call.tool}" in scenario "${this.scenarioId}". ` +
            `Looked for ${filePath} (${reason}). Strict mode is on.`,
        );
      }
      // Non-strict: surface the gap loudly, then hand the agent an empty,
      // clearly-marked result so it keeps going instead of derailing.
      const hash = argsHash(call.args);
      console.error(
        `[fixture] MISS scenarioId=${this.scenarioId} tool=${call.tool} ` +
          `argshash=${hash} (looked for ${filePath}; ${reason})`,
      );
      return {
        tool: call.tool,
        args: call.args,
        output: { uncaptured: true, tool: call.tool, args: call.args },
      };
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
