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
//
// The name-lookup tools get_configmap and get_secret_meta are the exception. They
// answer an existence question over an unbounded name space: an exploring agent
// probes them with names it infers (the deployment name, a pod's template-hash
// suffix) to rule MissingConfigOrSecret in or out, and most inferred names were
// never captured because they never existed. A miss there is not a coverage hole
// but a legitimate, informative answer: the resource is absent. So instead of the
// uncaptured marker, a miss on one of these returns the exact structured not-found
// the LiveProvider produces for a genuinely absent resource
// ({ namespace, name, exists: false, data: {} } for a ConfigMap;
// { namespace, name, exists: false, keys: [] } for a Secret), and logs a distinct
// one-line NOTFOUND rather than MISS so it stays visible but is understood as a
// real answer, not a gap. Capturing one more name could never close this: the name
// space is unbounded, so the fix is structural. Every other tool keeps the
// uncaptured-marker behavior; only these two have a well-defined absence answer.

import { readFile } from "node:fs/promises";
import path from "node:path";

import { fixtureKey } from "../tools/canonicalizeToolArgs";
import { toolDefinitions } from "../tools";
import type { GetConfigmapOutput, GetSecretMetaOutput } from "../tools";
import type {
  ToolCall,
  ToolDefinition,
  ToolProvider,
  ToolResult,
} from "../types";

// The name-lookup tools that answer an existence question and therefore have a
// well-defined not-found answer when their fixture is absent. See the header note.
// The builder returns exactly the structured absence the LiveProvider produces for
// a genuinely missing resource, keyed off the call's canonical namespace and name,
// so replay is indistinguishable from a real not-found. Any other tool is absent
// from this map and keeps the uncaptured-marker behavior.
const NAME_LOOKUP_NOT_FOUND: Record<
  string,
  (namespace: string, name: string) => GetConfigmapOutput | GetSecretMetaOutput
> = {
  get_configmap: (namespace, name) => ({
    namespace,
    name,
    exists: false,
    data: {},
  }),
  get_secret_meta: (namespace, name) => ({
    namespace,
    name,
    exists: false,
    keys: [],
  }),
};

// Default fixtures root, relative to the process working directory. Capture and
// eval both run from the project root, so cwd resolves correctly today.
// TODO: resolve this relative to the package root rather than cwd, so a caller
// invoking the provider from another directory still finds the fixtures.
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
    const fileName = `${call.tool}-${fixtureKey(call)}.json`;
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
      const hash = fixtureKey(call);
      // A name-lookup tool (get_configmap, get_secret_meta) has a well-defined
      // absence answer: an uncaptured name means the resource does not exist. Return
      // the exact structured not-found the LiveProvider gives, and log a distinct
      // NOTFOUND so it reads as a legitimate answer the agent uses to rule causes
      // out, not as a coverage gap.
      const notFound = NAME_LOOKUP_NOT_FOUND[call.tool];
      if (notFound) {
        console.error(
          `[fixture] NOTFOUND scenarioId=${this.scenarioId} tool=${call.tool} ` +
            `name=${call.args.name ?? ""} argshash=${hash} ` +
            `(no fixture at ${filePath}; treating as absent resource)`,
        );
        return {
          tool: call.tool,
          args: call.args,
          output: notFound(call.args.namespace ?? "", call.args.name ?? ""),
        };
      }
      // Non-strict: surface the gap loudly, then hand the agent an empty,
      // clearly-marked result so it keeps going instead of derailing.
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
