// LiveProvider talks to a real cluster. Local development only.
//
// It never runs in production. The deployed demo and the eval harness use
// FixtureProvider instead. This is a stub for now: the read-only cluster calls
// are a later quest.

import { toolDefinitions } from "../tools";
import type {
  ToolCall,
  ToolDefinition,
  ToolProvider,
  ToolResult,
} from "../types";

export class LiveProvider implements ToolProvider {
  listTools(): ToolDefinition[] {
    return toolDefinitions;
  }

  async resolve(_call: ToolCall): Promise<ToolResult> {
    throw new Error("local only, not implemented");
  }
}
