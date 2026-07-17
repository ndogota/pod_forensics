// AnthropicModelClient: a real ModelClient backed by the Anthropic SDK.
//
// Local and optional. The committed eval runs on FakeModelClient so it is
// deterministic and free. This client is here so the same agent loop can run
// against a real model when ANTHROPIC_API_KEY is set.
//
// It defaults to claude-sonnet-4-6 to keep real runs cheap; Opus is available by
// passing the model explicitly (via `pnpm eval --model claude-opus-4-8`) for a
// final showcase run.
//
// Prompt caching: the system prompt and the tool definitions block are static
// across the whole loop, so each carries an ephemeral cache breakpoint. The
// growing message history is cached incrementally by marking the last content
// block of the most recent turn, so every step after the first reads the earlier
// turns from cache instead of reprocessing them. Render order is tools, then
// system, then messages, and there are at most three breakpoints, within the
// four-breakpoint limit.
//
// Note on thinking: this client runs without extended thinking to keep the
// manual tool-use loop simple. Adaptive thinking would require echoing thinking
// blocks back unchanged across turns, which the minimal ModelClient message
// shape does not carry.
// TODO: enable adaptive thinking once the loop preserves thinking blocks.

import Anthropic from "@anthropic-ai/sdk";

import { estimateCostUsd } from "./pricing";
import type {
  CompletionRequest,
  CompletionResult,
  ModelClient,
  ModelContentBlock,
  ModelMessage,
} from "./modelClient";

const DEFAULT_MODEL = "claude-sonnet-4-6";
const DEFAULT_MAX_TOKENS = 4096;

// A single ephemeral cache breakpoint, reused at every placement.
const EPHEMERAL = { type: "ephemeral" } as const;

function toSdkMessages(messages: ModelMessage[]): Anthropic.MessageParam[] {
  const sdk: Anthropic.MessageParam[] = messages.map((m) => {
    if (m.role === "user") {
      if (typeof m.content === "string") {
        return { role: "user", content: m.content };
      }
      return {
        role: "user",
        content: m.content.map((r) => ({
          type: "tool_result" as const,
          tool_use_id: r.toolUseId,
          content: r.content,
          is_error: r.isError,
        })),
      };
    }
    return {
      role: "assistant",
      content: m.content.map((b) =>
        b.type === "text"
          ? { type: "text" as const, text: b.text }
          : {
              type: "tool_use" as const,
              id: b.id,
              name: b.name,
              input: b.input,
            },
      ),
    };
  });
  // Cache the conversation prefix incrementally: marking the last content block
  // of the most recent turn makes the whole prefix up to here a cache entry, so
  // the next step reads all earlier turns from cache.
  markLastBlockCached(sdk);
  return sdk;
}

function markLastBlockCached(messages: Anthropic.MessageParam[]): void {
  const last = messages[messages.length - 1];
  if (!last) return;
  if (typeof last.content === "string") {
    last.content = [
      { type: "text", text: last.content, cache_control: EPHEMERAL },
    ];
    return;
  }
  const block = last.content[last.content.length - 1];
  if (block) {
    (block as { cache_control?: typeof EPHEMERAL }).cache_control = EPHEMERAL;
  }
}

export class AnthropicModelClient implements ModelClient {
  readonly model: string;
  private readonly client: Anthropic;
  // The per-response output token ceiling. Public and readonly so a run can
  // report the value it is operating with. Defaults to DEFAULT_MAX_TOKENS (4096),
  // large enough that the evidence array plus the trailing suggestedFix and
  // confidence fields fit in one turn; a text preamble before the tool call still
  // leaves room for the full payload. Configurable via the constructor.
  readonly maxTokens: number;

  constructor(
    opts: { model?: string; apiKey?: string; maxTokens?: number } = {},
  ) {
    this.model = opts.model ?? DEFAULT_MODEL;
    this.maxTokens = opts.maxTokens ?? DEFAULT_MAX_TOKENS;
    // The SDK reads ANTHROPIC_API_KEY from the environment when apiKey is unset.
    this.client = new Anthropic(opts.apiKey ? { apiKey: opts.apiKey } : {});
  }

  async complete(req: CompletionRequest): Promise<CompletionResult> {
    // The tool definitions are static across the loop; cache them with one
    // breakpoint on the last tool, which covers the whole block.
    const tools: Anthropic.Tool[] = req.tools.map((t) => ({
      name: t.name,
      description: t.description,
      input_schema: t.inputSchema as Anthropic.Tool.InputSchema,
    }));
    if (tools.length > 0) {
      tools[tools.length - 1].cache_control = EPHEMERAL;
    }

    const response = await this.client.messages.create({
      model: this.model,
      max_tokens: req.maxTokens ?? this.maxTokens,
      // The system prompt is static across the loop, so cache it too.
      system: [{ type: "text", text: req.system, cache_control: EPHEMERAL }],
      tools,
      messages: toSdkMessages(req.messages),
    });

    const content: ModelContentBlock[] = [];
    for (const block of response.content) {
      if (block.type === "text") {
        content.push({ type: "text", text: block.text });
      } else if (block.type === "tool_use") {
        content.push({
          type: "tool_use",
          id: block.id,
          name: block.name,
          input: (block.input ?? {}) as Record<string, unknown>,
        });
      }
    }

    const tokensIn = response.usage.input_tokens;
    const tokensOut = response.usage.output_tokens;
    const cacheReadTokens = response.usage.cache_read_input_tokens ?? 0;
    const cacheCreationTokens = response.usage.cache_creation_input_tokens ?? 0;

    return {
      content,
      stopReason: response.stop_reason ?? "end_turn",
      tokensIn,
      tokensOut,
      cacheReadTokens,
      cacheCreationTokens,
      costUsd: estimateCostUsd(this.model, {
        inputTokens: tokensIn,
        outputTokens: tokensOut,
        cacheReadTokens,
        cacheCreationTokens,
      }),
    };
  }
}
