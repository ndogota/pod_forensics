// The ToolProvider seam.
//
// The agent depends only on this interface, never on a concrete provider. That
// is the load-bearing decision: the agent cannot tell whether a tool call is
// served from a captured fixture or from a live cluster.
//
// The interface itself is a frozen contract and lives in types.ts. This module
// re-exports it so provider code and the agent import the seam from one place.

export type {
  ToolProvider,
  ToolDefinition,
  ToolCall,
  ToolResult,
} from "../types";
