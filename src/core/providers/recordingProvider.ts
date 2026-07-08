// RecordingProvider: a decorator that materializes fixtures.
//
// It wraps any ToolProvider. On resolve it delegates to the inner provider,
// writes the ToolResult to src/fixtures/<scenarioId>/<tool>-<argshash>.json
// using the shared fixtureKey (canonicalize + argsHash), then returns the result.
// It is the only writer of fixtures: capture is the sole path that creates them,
// so the read side (FixtureProvider) and the write side agree on the filename by
// construction.
//
// The written file is { capturedAt, output }, the exact shape FixtureProvider
// reads back. capturedAt is stamped here, at write time.

import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";

import { fixtureKey } from "../tools/canonicalizeToolArgs";
import type {
  ToolCall,
  ToolDefinition,
  ToolProvider,
  ToolResult,
} from "../types";

const DEFAULT_FIXTURES_ROOT = path.resolve(process.cwd(), "src/fixtures");

export class RecordingProvider implements ToolProvider {
  private readonly inner: ToolProvider;
  private readonly scenarioId: string;
  private readonly fixturesRoot: string;

  constructor(
    inner: ToolProvider,
    scenarioId: string,
    fixturesRoot: string = DEFAULT_FIXTURES_ROOT,
  ) {
    this.inner = inner;
    this.scenarioId = scenarioId;
    this.fixturesRoot = fixturesRoot;
  }

  listTools(): ToolDefinition[] {
    return this.inner.listTools();
  }

  fixturePath(call: ToolCall): string {
    const fileName = `${call.tool}-${fixtureKey(call)}.json`;
    return path.join(this.fixturesRoot, this.scenarioId, fileName);
  }

  async resolve(call: ToolCall): Promise<ToolResult> {
    const result = await this.inner.resolve(call);

    const capturedAt = new Date().toISOString();
    const filePath = this.fixturePath(call);
    await mkdir(path.dirname(filePath), { recursive: true });
    await writeFile(
      filePath,
      JSON.stringify({ capturedAt, output: result.output }, null, 2) + "\n",
      "utf8",
    );

    return { ...result, capturedAt };
  }
}
