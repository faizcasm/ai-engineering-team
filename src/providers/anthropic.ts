/** Anthropic Messages API provider with SSE streaming. */

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
import { parseSse, postJson, raiseForStatus } from "./http.js";

export interface AnthropicOptions {
  apiKey: string;
  baseUrl?: string;
  debug?: (message: string, extra?: unknown) => void;
}

interface AnthropicToolResult {
  content: Array<
    | { type: "text"; text: string }
    | { type: "tool_use"; id: string; name: string; input: unknown }
  >;
  stop_reason: "end_turn" | "tool_use" | "max_tokens" | null;
  usage?: {
    input_tokens?: number;
    output_tokens?: number;
    cache_creation_input_tokens?: number;
    cache_read_input_tokens?: number;
  };
}

function toAnthropicMessages(messages: Message[]): unknown[] {
  return messages.map((message) => ({
    role: message.role,
    content: message.content.map((block): unknown => {
      if (block.type === "text") return { type: "text", text: block.text };
      if (block.type === "tool_use") return { type: "tool_use", id: block.id, name: block.name, input: block.input };
      return { type: "tool_result", tool_use_id: block.toolUseId, content: block.content, is_error: block.isError ?? false };
    }),
  }));
}

function mapStopReason(reason: string | null | undefined): StopReason {
  switch (reason) {
    case "tool_use":
      return "tool_use";
    case "max_tokens":
      return "max_tokens";
    case "end_turn":
      return "end_turn";
    default:
      return reason ? (reason as StopReason) : "end_turn";
  }
}

function usageFrom(raw: AnthropicToolResult["usage"]): Usage {
  return {
    inputTokens: raw?.input_tokens ?? 0,
    outputTokens: raw?.output_tokens ?? 0,
    cacheReadTokens: raw?.cache_read_input_tokens ?? 0,
    cacheWriteTokens: raw?.cache_creation_input_tokens ?? 0,
  };
}

export class AnthropicProvider implements Provider {
  readonly id = "anthropic";
  private readonly apiKey: string;
  private readonly baseUrl: string;
  private readonly debug?: (message: string, extra?: unknown) => void;

  constructor(options: AnthropicOptions) {
    this.apiKey = options.apiKey;
    this.baseUrl = (options.baseUrl ?? "https://api.anthropic.com").replace(/\/$/, "");
    this.debug = options.debug;
  }

  private buildBody(request: ChatRequest): Record<string, unknown> {
    const body: Record<string, unknown> = {
      model: request.model,
      max_tokens: request.maxTokens ?? 8192,
      system: request.system,
      messages: toAnthropicMessages(request.messages),
      stream: true,
    };
    if (request.temperature !== undefined) body.temperature = request.temperature;
    if (request.tools.length > 0) {
      body.tools = request.tools.map((tool) => ({
        name: tool.name,
        description: tool.description,
        input_schema: tool.inputSchema,
      }));
    }
    return body;
  }

  async *stream(request: ChatRequest): AsyncGenerator<StreamEvent> {
    const response = await postJson(
      `${this.baseUrl}/v1/messages`,
      {
        "x-api-key": this.apiKey,
        "anthropic-version": "2023-06-01",
        "anthropic-dangerous-direct-browser-access": "true",
      },
      this.buildBody(request),
      request.signal,
    );
    await raiseForStatus(response, this.id);
    if (!response.body) throw new Error("anthropic response missing body");

    const content: ContentBlock[] = [];
    let usage: Usage = { inputTokens: 0, outputTokens: 0 };
    let stopReason: StopReason = "end_turn";
    let currentToolIndex = -1;
    let toolInputBuffer = "";

    for await (const payload of parseSse(response.body)) {
      if (payload === "[DONE]") break;
      let event: Record<string, unknown>;
      try {
        event = JSON.parse(payload) as Record<string, unknown>;
      } catch {
        continue;
      }
      const type = String(event.type ?? "");

      switch (type) {
        case "message_start": {
          const message = event.message as AnthropicToolResult | undefined;
          usage = usageFrom(message?.usage);
          break;
        }
        case "content_block_start": {
          const block = event.content_block as Record<string, unknown> | undefined;
          if (block?.type === "text") {
            content.push({ type: "text", text: String(block.text ?? "") });
          } else if (block?.type === "tool_use") {
            currentToolIndex = content.length;
            toolInputBuffer = "";
            content.push({
              type: "tool_use",
              id: String(block.id ?? `tool_${currentToolIndex}`),
              name: String(block.name ?? ""),
              input: {},
            });
          }
          break;
        }
        case "content_block_delta": {
          const delta = event.delta as Record<string, unknown> | undefined;
          if (delta?.type === "text_delta") {
            const text = String(delta.text ?? "");
            const last = content[content.length - 1];
            if (last?.type === "text") last.text += text;
            if (text) yield { type: "text", text };
          } else if (delta?.type === "input_json_delta") {
            toolInputBuffer += String(delta.partial_json ?? "");
          }
          break;
        }
        case "content_block_stop": {
          if (currentToolIndex >= 0) {
            const block = content[currentToolIndex];
            if (block?.type === "tool_use") {
              try {
                block.input = toolInputBuffer.trim().length > 0 ? JSON.parse(toolInputBuffer) : {};
              } catch {
                block.input = { _raw: toolInputBuffer };
              }
            }
            currentToolIndex = -1;
            toolInputBuffer = "";
          }
          break;
        }
        case "message_delta": {
          const delta = event.delta as { stop_reason?: string } | undefined;
          const deltaUsage = event.usage as { output_tokens?: number } | undefined;
          if (deltaUsage?.output_tokens) usage.outputTokens = Math.max(usage.outputTokens, deltaUsage.output_tokens);
          if (delta?.stop_reason) stopReason = mapStopReason(delta.stop_reason);
          break;
        }
        case "error": {
          const error = event.error as { message?: string } | undefined;
          throw new Error(`anthropic stream error: ${error?.message ?? "unknown"}`);
        }
        default:
          break;
      }
    }

    const message: Message = { role: "assistant", content, model: request.model, timestamp: new Date().toISOString() };
    if (stopReason === "end_turn" && content.some((block) => block.type === "tool_use")) {
      stopReason = "tool_use";
    }
    this.debug?.("anthropic done", { stopReason, usage });
    yield { type: "done", message, usage, stopReason };
  }

  async complete(request: ChatRequest): Promise<ChatResult> {
    for await (const event of this.stream(request)) {
      if (event.type === "done") {
        return { message: event.message, usage: event.usage, stopReason: event.stopReason };
      }
    }
    throw new Error("anthropic stream ended without a result");
  }
}
