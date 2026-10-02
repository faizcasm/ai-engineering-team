/** Shared HTTP helpers: SSE line parsing and JSON error handling. */

import { style } from "../util/color.js";

export class ProviderError extends Error {
  constructor(
    message: string,
    readonly status: number,
    readonly body?: string,
    readonly provider?: string,
  ) {
    super(message);
    this.name = "ProviderError";
  }

  override toString(): string {
    const status = style.red(`[${this.status}]`);
    return `${status} ${this.message}`;
  }
}

/**
 * Parse a text/event-stream into raw `data:` payloads (newline delimited,
 * one yield per event). Comments (`:` keep-alives) are ignored.
 */
export async function* parseSse(stream: ReadableStream<Uint8Array>): AsyncGenerator<string> {
  const reader = stream.getReader();
  const decoder = new TextDecoder();
  let buffer = "";
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      buffer += decoder.decode(value, { stream: true });
      let index = buffer.indexOf("\n");
      while (index !== -1) {
        const rawLine = buffer.slice(0, index);
        buffer = buffer.slice(index + 1);
        const line = rawLine.endsWith("\r") ? rawLine.slice(0, -1) : rawLine;
        if (line.length > 0 && !line.startsWith(":") && line.toLowerCase().startsWith("data:")) {
          yield line.slice(5).replace(/^ /, "");
        }
        index = buffer.indexOf("\n");
      }
    }
  } finally {
    reader.releaseLock();
  }
}

export async function raiseForStatus(response: Response, provider: string): Promise<void> {
  if (response.ok) return;
  let body = "";
  try {
    body = await response.text();
  } catch {
    body = "";
  }
  let message = `${provider} request failed`;
  try {
    const parsed = JSON.parse(body) as { error?: { message?: string } | string };
    const err = parsed.error;
    message = typeof err === "string" ? err : err?.message ?? message;
  } catch {
    message = body ? `${message}: ${body.slice(0, 300)}` : message;
  }
  if (response.status === 401 || response.status === 403) {
    message += " (check your API key with `aet auth status`)";
  } else if (response.status === 429) {
    message += " (rate limited - retry shortly)";
  }
  throw new ProviderError(message, response.status, body, provider);
}

/** POST JSON with an optional abort signal and sane timeout. */
export async function postJson(
  url: string,
  headers: Record<string, string>,
  body: unknown,
  signal?: AbortSignal,
  timeoutMs = 600_000,
): Promise<Response> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(new Error(`request timed out after ${timeoutMs}ms`)), timeoutMs);
  const onAbort = (): void => controller.abort(signal?.reason ?? new Error("aborted"));
  signal?.addEventListener("abort", onAbort, { once: true });
  try {
    return await fetch(url, {
      method: "POST",
      headers: { "content-type": "application/json", ...headers },
      body: JSON.stringify(body),
      signal: controller.signal,
    });
  } finally {
    clearTimeout(timer);
    signal?.removeEventListener("abort", onAbort);
  }
}
