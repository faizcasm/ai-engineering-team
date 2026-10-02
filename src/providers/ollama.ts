/** Ollama /chat provider (local models, NDJSON streaming). */

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
import { raiseForStatus } from "./http.js";
import { toOpenAiMessages, mapStopReason } from "./openai.js";

export interface OllamaOptions {
  baseUrl?: string;
  apiKey?: string;
  debug?: (message: string, extra?: unknown) => void;
}

export class OllamaProvider implements Provider {
  readonly id = "ollama";
  private readonly baseUrl: string;
  private readonly apiKey?: string;
  private readonly debug?: (message: string, extra?: unknown) => void;

  constructor(options: OllamaOptions = {}) {
    this.baseUrl = (options.baseUrl ?? process.env.OLLAMA_HOST ?? "http://127.0.0.1:11434").replace(/\/$/, "");
    this.apiKey = options.apiKey;
    this.debug = options.debug;
  }

  async *stream(request: ChatRequest): AsyncGenerator<StreamEvent> {
    const headers: Record<string, string> = {};
    if (this.apiKey) headers.authorization = `Bearer ${this.apiKey}`;

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
    }
    const options: Record<string, unknown> = {};
    if (request.temperature !== undefined) options.temperature = request.temperature;
    if (request.maxTokens !== undefined) options.num_predict = request.maxTokens;
    if (Object.keys(options).length > 0) body.options = options;

    const response = await fetch(`${this.baseUrl}/api/chat`, {
      method: "POST",
      headers: { "content-type": "application/json", ...headers },
      body: JSON.stringify(body),
      signal: request.signal,
    });
    await raiseForStatus(response, this.id);
    if (!response.body) throw new Error("ollama response missing body");

    const decoder = new TextDecoder();
    const reader = response.body.getReader();
    let buffer = "";
    let text = "";
    const toolCalls: Array<{ id: string; name: string; input: unknown }> = [];
    let usage: Usage = { inputTokens: 0, outputTokens: 0 };
    let stopReason: StopReason = "end_turn";

    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      buffer += decoder.decode(value, { stream: true });
      let index = buffer.indexOf("\n");
      while (index !== -1) {
        const line = buffer.slice(0, index).trim();
        buffer = buffer.slice(index + 1);
        if (line.length > 0) {
          try {
            const chunk = JSON.parse(line) as {
              message?: { content?: string; tool_calls?: Array<{ function?: { name?: string; arguments?: unknown } }> };
              done?: boolean;
              prompt_eval_count?: number;
              eval_count?: number;
              error?: string;
            };
            if (chunk.error) throw new Error(`ollama: ${chunk.error}`);
            const piece = chunk.message?.content;
            if (piece) {
              text += piece;
              yield { type: "text", text: piece };
            }
            for (const call of chunk.message?.tool_calls ?? []) {
              const name = call.function?.name ?? "";
              let input: unknown = call.function?.arguments ?? {};
              if (typeof input === "string") {
                try {
                  input = JSON.parse(input);
                } catch {
                  input = { _raw: input };
                }
              }
              toolCalls.push({ id: `call_${toolCalls.length}_${Date.now().toString(36)}`, name, input });
            }
            if (chunk.done) {
              if (chunk.prompt_eval_count) usage.inputTokens = chunk.prompt_eval_count;
              if (chunk.eval_count) usage.outputTokens = chunk.eval_count;
              if (toolCalls.length > 0) stopReason = "tool_use";
            }
          } catch (error) {
            if (error instanceof Error && error.message.startsWith("ollama:")) throw error;
            // ignore partial line
          }
        }
        index = buffer.indexOf("\n");
      }
    }

    const content: ContentBlock[] = [];
    if (text.length > 0) content.push({ type: "text", text });
    for (const call of toolCalls) content.push({ type: "tool_use", ...call });
    const message: Message = { role: "assistant", content, model: request.model, timestamp: new Date().toISOString() };
    this.debug?.("ollama done", { stopReason, usage, tools: toolCalls.length });
    yield { type: "done", message, usage, stopReason };
  }

  async complete(request: ChatRequest): Promise<ChatResult> {
    for await (const event of this.stream(request)) {
      if (event.type === "done") {
        return { message: event.message, usage: event.usage, stopReason: event.stopReason };
      }
    }
    throw new Error("ollama stream ended without a result");
  }
}
