/**
 * Token estimation.
 *
 * We intentionally avoid shipping a tokenizer: an approximation of ~4 chars
 * per token is accurate enough for context-window budgeting, and providers
 * report exact usage which we fold back in (see `TokenCounter`).
 */

export function estimateTokens(text: string): number {
  if (text.length === 0) return 0;
  const words = text.split(/\s+/).length;
  const byChars = Math.ceil(text.length / 4);
  const byWords = Math.ceil(words * 1.3);
  // Take the mean so neither very dense code nor very sparse prose dominates.
  return Math.max(1, Math.ceil((byChars + byWords) / 2));
}

export class TokenCounter {
  inputTokens = 0;
  outputTokens = 0;
  cacheReadTokens = 0;
  cacheWriteTokens = 0;
  requests = 0;

  addUsage(usage: {
    inputTokens: number;
    outputTokens: number;
    cacheReadTokens?: number;
    cacheWriteTokens?: number;
  }): void {
    this.inputTokens += usage.inputTokens;
    this.outputTokens += usage.outputTokens;
    this.cacheReadTokens += usage.cacheReadTokens ?? 0;
    this.cacheWriteTokens += usage.cacheWriteTokens ?? 0;
    this.requests += 1;
  }

  total(): number {
    return (
      this.inputTokens +
      this.outputTokens +
      this.cacheReadTokens +
      this.cacheWriteTokens
    );
  }

  reset(): void {
    this.inputTokens = 0;
    this.outputTokens = 0;
    this.cacheReadTokens = 0;
    this.cacheWriteTokens = 0;
    this.requests = 0;
  }
}
