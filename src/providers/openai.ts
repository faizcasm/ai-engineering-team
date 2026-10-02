/** OpenAI Chat Completions provider (also powers OpenRouter / Groq / DeepSeek). */

import type {
  ChatRequest,
  ChatResult,
  ContentBlock,
  Message,
  Provider,
  StopReason,
  StreamEvent,
  Usage,
} from "../core/types.js";

export interface OpenAiOptions {
  apiKey?: string;
  baseUrl: string;
  providerId?: string;
  debug?: (message: string, extra?: unknown) => void;
  /** Add `stream_options.include_usage` (not supported by every clone). */
  includeUsage?: boolean;
}

interface OpenAiToolCall {
  index: number;
  id?: string;
  type?: string;
  function?: { name?: string; arguments?: string };
}

function joinedText(message: Message): string {
  return message.content
    .map((block) => (block.type === "text" ? block.text : ""))
    .filter(Boolean)
    .join("");
}

export function toOpenAiMessages(system: string, messages: Message[]): unknown[] {
  const out: Array<Record<string, unknown>> = [{ role: "system", content: system }];
  for (const message of messages) {
    if (message.role === "assistant") {
      const text = joinedText(message);
      const calls = message.content.filter((block) => block.type === "tool_use");
      if (calls.length > 0) {
        out.push({
          role: "assistant",
          content: text.length > 0 ? text : null,
          tool_calls: calls.map((block) =>
            block.type === "tool_use"
              ? {
                  id: block.id,
                  type: "function",
                  function: { name: block.name, arguments: JSON.stringify(block.input ?? {}) },
                }
              : null,
          ),
        });
      } else if (text.length > 0) {
        out.push({ role: "assistant", content: text });
      }
      continue;
    }
    const results = message.content.filter((block) => block.type === "tool_result");
    const text = joinedText(message);
    for (const block of results) {
      if (block.type !== "tool_result") continue;
      out.push({ role: "tool", tool_call_id: block.toolUseId, content: block.content });
    }
    if (text.length > 0) out.push({ role: "user", content: text });
    if (results.length === 0 && text.length === 0) out.push({ role: "user", content: "..." });
  }
  return out;
}

function isReasoningModel(model: string): boolean {
  return /^(o[0-9]|gpt-5|codex)/i.test(model);
}

export function mapStopReason(finishReason: string | null | undefined): StopReason {
  switch (finishReason) {
    case "tool_calls":
    case "function_call":
      return "tool_use";
    case "length":
      return "max_tokens";
    case "stop":
      return "stop";
    default:
      return finishReason ? (finishReason as StopReason) : "end_turn";
  }
}

export class OpenAiProvider implements Provider {
  readonly id: string;
  private readonly apiKey?: string;
  private readonly baseUrl: string;
  private readonly debug?: (message: string, extra?: unknown) => void;
  private readonly includeUsage: boolean;

  constructor(options: OpenAiOptions) {
    this.id = options.providerId ?? "openai";
    this.apiKey = options.apiKey;
    this.baseUrl = options.baseUrl.replace(/\/$/, "");
    this.debug = options.debug;
    this.includeUsage = options.includeUsage ?? true;
  }

  private buildBody(request: ChatRequest): Record<string, unknown> {
    const body: Record<string, unknown> = {
      model: request.model,
      messages: toOpenAiMessages(request.system, request.messages),
      stream: true,
    };
    if (request.tools.length > 0) {
      body.tools = request.tools.map((tool) => ({
        type: "function",
        function: { name: tool.name, description: tool.description, parameters: tool.inputSchema },
      }));
      body.tool_choice = "auto";
    }
    if (request.maxTokens !== undefined) {
      if (isReasoningModel(request.model)) body.max_completion_tokens = request.maxTokens;
      else body.max_tokens = request.maxTokens;
    }
    if (request.temperature !== undefined && !isReasoningModel(request.model)) {
      body.temperature = request.temperature;
    }
    if (this.includeUsage) body.stream_options = { include_usage: true };
    return body;
  }

  async *stream(request: ChatRequest): AsyncGenerator<StreamEvent> {
    const headers: Record<string, string> = {};
    if (this.apiKey) headers.authorization = `Bearer ${this.apiKey}`;

    const response = await fetch(`${this.baseUrl}/chat/completions`, {
      method: "POST",
      headers: { "content-type": "application/json", ...headers },
      body: JSON.stringify(this.buildBody(request)),
      signal: request.signal,
    });
    if (!response.ok) {
      const { raiseForStatus } = await import("./http.js");
      await raiseForStatus(response, this.id);
    }
    if (!response.body) throw new Error("openai response missing body");

    const decoder = new TextDecoder();
    const reader = response.body.getReader();
    let buffer = "";
    let text = "";
    const toolCalls = new Map<number, { id: string; name: string; args: string }>();
    let usage: Usage = { inputTokens: 0, outputTokens: 0 };
    let stopReason: StopReason = "end_turn";
    let finished = false;

    const handlePayload = (payload: string): StreamEvent[] => {
      const events: StreamEvent[] = [];
      if (payload === "[DONE]") {
        finished = true;
        return events;
      }
      let chunk: Record<string, unknown>;
      try {
        chunk = JSON.parse(payload) as Record<string, unknown>;
      } catch {
        return events;
      }
      const chunkUsage = chunk.usage as
        | { prompt_tokens?: number; completion_tokens?: number; prompt_tokens_details?: { cached_tokens?: number } }
        | undefined;
      if (chunkUsage) {
        usage = {
          inputTokens: chunkUsage.prompt_tokens ?? 0,
          outputTokens: chunkUsage.completion_tokens ?? 0,
          cacheReadTokens: chunkUsage.prompt_tokens_details?.cached_tokens ?? 0,
        };
      }
      const choices = chunk.choices as Array<{ delta?: { content?: string | null; tool_calls?: OpenAiToolCall[] }; finish_reason?: string | null }> | undefined;
      if (!choices || choices.length === 0) return events;
      const choice = choices[0]!;
      const delta = choice.delta ?? {};
      if (typeof delta.content === "string" && delta.content.length > 0) {
        text += delta.content;
        events.push({ type: "text", text: delta.content });
      }
      if (delta.tool_calls) {
        for (const call of delta.tool_calls) {
          const existing = toolCalls.get(call.index) ?? { id: "", name: "", args: "" };
          if (call.id) existing.id = call.id;
          if (call.function?.name) existing.name += call.function.name;
          if (call.function?.arguments) existing.args += call.function.arguments;
          toolCalls.set(call.index, existing);
        }
      }
      if (choice.finish_reason) stopReason = mapStopReason(choice.finish_reason);
      return events;
    };

    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      buffer += decoder.decode(value, { stream: true });
      let index = buffer.indexOf("\n");
      while (index !== -1) {
        const line = buffer.slice(0, index).trim();
        buffer = buffer.slice(index + 1);
        if (line.startsWith("data:")) {
          for (const event of handlePayload(line.slice(5).trim())) yield event;
          if (finished) break;
        }
        index = buffer.indexOf("\n");
      }
      if (finished) break;
    }

    const content: ContentBlock[] = [];
    if (text.length > 0) content.push({ type: "text", text });
    for (const [, call] of [...toolCalls.entries()].sort((a, b) => a[0] - b[0])) {
      let input: unknown = {};
      try {
        input = call.args.trim().length > 0 ? JSON.parse(call.args) : {};
      } catch {
        input = { _raw: call.args };
      }
      content.push({
        type: "tool_use",
        id: call.id || `call_${Math.random().toString(36).slice(2, 10)}`,
        name: call.name,
        input,
      });
    }
    if (stopReason === "end_turn" && toolCalls.size > 0) stopReason = "tool_use";

    const message: Message = { role: "assistant", content, model: request.model, timestamp: new Date().toISOString() };
    this.debug?.(`${this.id} done`, { stopReason, usage, tools: toolCalls.size });
    yield { type: "done", message, usage, stopReason };
  }

  async complete(request: ChatRequest): Promise<ChatResult> {
    for await (const event of this.stream(request)) {
      if (event.type === "done") {
        return { message: event.message, usage: event.usage, stopReason: event.stopReason };
      }
    }
    throw new Error("openai stream ended without a result");
  }
}
