// Model pricing and cost arithmetic.
//
// A small pricing table keyed by model id, in USD per million tokens. Cost is
// pure local arithmetic on usage the model API already returned; nothing here
// ever touches the network. Cache reads bill at 0.1x the input rate and cache
// writes at 1.25x (the 5-minute ephemeral TTL used by AnthropicModelClient).

export interface ModelPricing {
  inPerM: number; // USD per million input tokens
  outPerM: number; // USD per million output tokens
}

// Published pricing per model. Keep in sync with the model catalog.
const PRICING: Record<string, ModelPricing> = {
  "claude-opus-4-8": { inPerM: 5, outPerM: 25 },
  "claude-sonnet-4-6": { inPerM: 3, outPerM: 15 },
  "claude-haiku-4-5": { inPerM: 1, outPerM: 5 },
};

const CACHE_READ_MULTIPLIER = 0.1;
const CACHE_WRITE_MULTIPLIER = 1.25;

// Resolve pricing for a model id. Exact aliases hit directly; dated snapshot ids
// (for example the judge's claude-haiku-4-5-20251001) resolve by alias prefix so
// the table stays small without missing them. Internal: estimateCostUsd is the
// module's public entry point.
function pricingFor(model: string): ModelPricing | undefined {
  if (PRICING[model]) return PRICING[model];
  for (const key of Object.keys(PRICING)) {
    if (model.startsWith(key)) return PRICING[key];
  }
  return undefined;
}

export interface Usage {
  inputTokens: number; // uncached input tokens billed at full rate
  outputTokens: number;
  cacheReadTokens?: number; // tokens served from cache, billed at 0.1x input
  cacheCreationTokens?: number; // tokens written to cache, billed at 1.25x input
}

// Estimated USD for one usage record. Unknown models (for example "fake-model")
// return 0, which keeps the deterministic fake run free.
export function estimateCostUsd(model: string, usage: Usage): number {
  const p = pricingFor(model);
  if (!p) return 0;
  const cacheRead = usage.cacheReadTokens ?? 0;
  const cacheCreate = usage.cacheCreationTokens ?? 0;
  return (
    (usage.inputTokens * p.inPerM +
      usage.outputTokens * p.outPerM +
      cacheRead * p.inPerM * CACHE_READ_MULTIPLIER +
      cacheCreate * p.inPerM * CACHE_WRITE_MULTIPLIER) /
    1_000_000
  );
}
