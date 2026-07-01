// The ModelClient seam.
//
// The agent loop talks to a model through this small interface, never to a
// concrete SDK. That lets the whole pipeline run offline and deterministically
// against a scripted FakeModelClient, and against a real model through
// AnthropicModelClient, without the loop knowing which is behind it.
//
// The message and content shapes here are deliberately minimal. They carry only
// what the loop needs: assistant text, tool calls, tool results, and usage.

// A block of assistant output.
export interface ModelTextBlock {
  type: "text";
  text: string;
}

export interface ModelToolUseBlock {
  type: "tool_use";
  id: string;
  name: string;
  input: Record<string, unknown>;
}

export type ModelContentBlock = ModelTextBlock | ModelToolUseBlock;

// A tool result the loop feeds back to the model.
export interface ModelToolResult {
  toolUseId: string;
  content: string;
  isError?: boolean;
}

// Conversation turns exchanged with the model.
export interface UserTurn {
  role: "user";
  content: string | ModelToolResult[];
}

export interface AssistantTurn {
  role: "assistant";
  content: ModelContentBlock[];
}

export type ModelMessage = UserTurn | AssistantTurn;

// A tool as advertised to the model. This is ToolDefinition by another name,
// kept local so the interface does not depend on the tools module.
export interface ModelTool {
  name: string;
  description: string;
  inputSchema: object;
}

export interface CompletionRequest {
  system: string;
  messages: ModelMessage[];
  tools: ModelTool[];
  maxTokens?: number;
}

export interface CompletionResult {
  content: ModelContentBlock[];
  stopReason: string;
  tokensIn: number;
  tokensOut: number;
  costUsd: number;
  // When set, the loop uses this instead of a measured wall-clock time. The
  // fake client sets it so committed reports are deterministic; the real client
  // leaves it undefined and the loop measures.
  latencyMs?: number;
}

export interface ModelClient {
  // Identifies the model for RunReport.model.
  readonly model: string;
  complete(req: CompletionRequest): Promise<CompletionResult>;
}
