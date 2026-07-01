// AnthropicModelClient: a real ModelClient backed by the Anthropic SDK.
//
// Local and optional. The committed eval runs on FakeModelClient so it is
// deterministic and free. This client is here so the same agent loop can run
// against a real model when ANTHROPIC_API_KEY is set.
//
// Note on thinking: this client runs without extended thinking to keep the
// manual tool-use loop simple. Adaptive thinking would require echoing thinking
// blocks back unchanged across turns, which the minimal ModelClient message
// shape does not carry.
// TODO: enable adaptive thinking once the loop preserves thinking blocks.

import Anthropic from "@anthropic-ai/sdk";

import type {
  CompletionRequest,
  CompletionResult,
  ModelClient,
  ModelContentBlock,
  ModelMessage,
} from "./modelClient";

// Price per million tokens, input and output. Used to fill RunTrace.costUsd.
// Keep in sync with published model pricing.
const PRICING: Record<string, { inPerM: number; outPerM: number }> = {
  "claude-opus-4-8": { inPerM: 5, outPerM: 25 },
  "claude-sonnet-4-6": { inPerM: 3, outPerM: 15 },
  "claude-haiku-4-5": { inPerM: 1, outPerM: 5 },
};

const DEFAULT_MODEL = "claude-opus-4-8";
const DEFAULT_MAX_TOKENS = 4096;

function costUsd(model: string, tokensIn: number, tokensOut: number): number {
  const p = PRICING[model];
  if (!p) return 0;
  return (tokensIn * p.inPerM + tokensOut * p.outPerM) / 1_000_000;
}

function toSdkMessages(messages: ModelMessage[]): Anthropic.MessageParam[] {
  return messages.map((m) => {
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
          : { type: "tool_use" as const, id: b.id, name: b.name, input: b.input },
      ),
    };
  });
}

export class AnthropicModelClient implements ModelClient {
  readonly model: string;
  private readonly client: Anthropic;
  private readonly maxTokens: number;

  constructor(opts: { model?: string; apiKey?: string; maxTokens?: number } = {}) {
    this.model = opts.model ?? DEFAULT_MODEL;
    this.maxTokens = opts.maxTokens ?? DEFAULT_MAX_TOKENS;
    // The SDK reads ANTHROPIC_API_KEY from the environment when apiKey is unset.
    this.client = new Anthropic(opts.apiKey ? { apiKey: opts.apiKey } : {});
  }

  async complete(req: CompletionRequest): Promise<CompletionResult> {
    const response = await this.client.messages.create({
      model: this.model,
      max_tokens: req.maxTokens ?? this.maxTokens,
      system: req.system,
      tools: req.tools.map((t) => ({
        name: t.name,
        description: t.description,
        input_schema: t.inputSchema as Anthropic.Tool.InputSchema,
      })),
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

    return {
      content,
      stopReason: response.stop_reason ?? "end_turn",
      tokensIn,
      tokensOut,
      costUsd: costUsd(this.model, tokensIn, tokensOut),
    };
  }
}
