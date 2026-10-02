/**
 * Model registry: known models with their provider, context window and
 * pricing (USD per million tokens). Unknown models still work - they simply
 * fall back to the defaults below.
 */

export interface ModelInfo {
  id: string;
  provider: "anthropic" | "openai" | "openrouter" | "ollama" | "mock";
  contextWindow: number;
  maxOutput: number;
  inputPrice: number;
  outputPrice: number;
  tools: boolean;
}

const DEFAULTS = {
  contextWindow: 200_000,
  maxOutput: 32_000,
  inputPrice: 3,
  outputPrice: 15,
};

const REGISTRY: ModelInfo[] = [
  // Anthropic
  { id: "claude-sonnet-4-5", provider: "anthropic", contextWindow: 200_000, maxOutput: 64_000, inputPrice: 3, outputPrice: 15, tools: true },
  { id: "claude-sonnet-4-6", provider: "anthropic", contextWindow: 200_000, maxOutput: 64_000, inputPrice: 3, outputPrice: 15, tools: true },
  { id: "claude-opus-4-5", provider: "anthropic", contextWindow: 200_000, maxOutput: 32_000, inputPrice: 5, outputPrice: 25, tools: true },
  { id: "claude-opus-4-6", provider: "anthropic", contextWindow: 200_000, maxOutput: 32_000, inputPrice: 5, outputPrice: 25, tools: true },
  { id: "claude-haiku-4-5", provider: "anthropic", contextWindow: 200_000, maxOutput: 16_000, inputPrice: 1, outputPrice: 5, tools: true },
  { id: "claude-3-5-haiku-latest", provider: "anthropic", contextWindow: 200_000, maxOutput: 8_000, inputPrice: 0.8, outputPrice: 4, tools: true },
  // OpenAI
  { id: "gpt-5.6-terra", provider: "openai", contextWindow: 400_000, maxOutput: 32_000, inputPrice: 1.25, outputPrice: 10, tools: true },
  { id: "gpt-5.1", provider: "openai", contextWindow: 400_000, maxOutput: 32_000, inputPrice: 1.25, outputPrice: 10, tools: true },
  { id: "gpt-4.1", provider: "openai", contextWindow: 1_047_576, maxOutput: 32_768, inputPrice: 2, outputPrice: 8, tools: true },
  { id: "gpt-4.1-mini", provider: "openai", contextWindow: 1_047_576, maxOutput: 32_768, inputPrice: 0.4, outputPrice: 1.6, tools: true },
  { id: "o4-mini", provider: "openai", contextWindow: 200_000, maxOutput: 100_000, inputPrice: 1.1, outputPrice: 4.4, tools: true },
  // Aggregators / local
  { id: "deepseek-chat", provider: "openrouter", contextWindow: 131_072, maxOutput: 8_192, inputPrice: 0.27, outputPrice: 1.1, tools: true },
  { id: "qwen2.5-coder:7b", provider: "ollama", contextWindow: 32_768, maxOutput: 8_192, inputPrice: 0, outputPrice: 0, tools: true },
  { id: "llama3.1:8b", provider: "ollama", contextWindow: 131_072, maxOutput: 8_192, inputPrice: 0, outputPrice: 0, tools: true },
  { id: "mock", provider: "mock", contextWindow: 100_000, maxOutput: 4_000, inputPrice: 0, outputPrice: 0, tools: true },
];

export function getModelInfo(model: string, provider?: string): ModelInfo {
  const known = REGISTRY.find((entry) => entry.id === model || model.endsWith(`:${entry.id}`));
  if (known && (!provider || known.provider === provider)) {
    return { ...known, id: model.includes(":") && known.provider !== "ollama" ? model.split("/").pop() ?? model : model };
  }
  return {
    id: model,
    provider: (provider as ModelInfo["provider"]) ?? inferProvider(model),
    contextWindow: DEFAULTS.contextWindow,
    maxOutput: DEFAULTS.maxOutput,
    inputPrice: DEFAULTS.inputPrice,
    outputPrice: DEFAULTS.outputPrice,
    tools: true,
  };
}

export function listModels(): ModelInfo[] {
  return REGISTRY.map((entry) => ({ ...entry }));
}

/** Best-effort provider inference from a bare model id. */
export function inferProvider(model: string): ModelInfo["provider"] {
  const lower = model.toLowerCase();
  if (lower.startsWith("claude")) return "anthropic";
  if (lower.startsWith("openrouter/") || lower.includes(":")) return "openrouter";
  if (/^(gpt|o[0-9]|codex|chatgpt)/.test(lower)) return "openai";
  if (lower.startsWith("mock")) return "mock";
  if (process.env.OLLAMA_HOST || lower.includes("ollama")) return "ollama";
  if (process.env.OPENAI_API_KEY && !process.env.ANTHROPIC_API_KEY) return "openai";
  return "anthropic";
}

export function costUsd(model: string, provider: string | undefined, usage: { inputTokens: number; outputTokens: number; cacheReadTokens?: number; cacheWriteTokens?: number }): number {
  const info = getModelInfo(model, provider);
  const input = usage.inputTokens / 1_000_000;
  const output = usage.outputTokens / 1_000_000;
  const cacheRead = (usage.cacheReadTokens ?? 0) / 1_000_000;
  const cacheWrite = (usage.cacheWriteTokens ?? 0) / 1_000_000;
  // Cache reads are billed at 10% and cache writes at 125% of the input rate.
  return input * info.inputPrice + output * info.outputPrice + cacheRead * info.inputPrice * 0.1 + cacheWrite * info.inputPrice * 1.25;
}
