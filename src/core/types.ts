/**
 * Core data model shared by providers, tools and the agent loop.
 *
 * The message format intentionally mirrors Anthropic's content-block model
 * (`text` / `tool_use` / `tool_result`); the OpenAI and Ollama adapters
 * translate to and from their own wire formats.
 */

export type Role = "user" | "assistant";

export interface TextBlock {
  type: "text";
  text: string;
}

export interface ToolUseBlock {
  type: "tool_use";
  id: string;
  name: string;
  input: unknown;
}

export interface ToolResultBlock {
  type: "tool_result";
  toolUseId: string;
  content: string;
  isError?: boolean;
}

export type ContentBlock = TextBlock | ToolUseBlock | ToolResultBlock;

export interface Message {
  role: Role;
  content: ContentBlock[];
  /** Model that produced an assistant message (informational). */
  model?: string;
  /** ISO timestamp recorded when the message entered the session. */
  timestamp?: string;
}

export interface Usage {
  inputTokens: number;
  outputTokens: number;
  cacheReadTokens?: number;
  cacheWriteTokens?: number;
}

export type StopReason = "end_turn" | "tool_use" | "max_tokens" | "stop" | "length" | "error";

export interface ToolSpec {
  name: string;
  description: string;
  /** JSON Schema for the tool input. */
  inputSchema: Record<string, unknown>;
}

export interface ChatRequest {
  system: string;
  messages: Message[];
  tools: ToolSpec[];
  model: string;
  temperature?: number;
  maxTokens?: number;
  signal?: AbortSignal;
}

export interface ChatResult {
  message: Message;
  usage: Usage;
  stopReason: StopReason;
}

export type StreamEvent =
  | { type: "text"; text: string }
  | { type: "done"; message: Message; usage: Usage; stopReason: StopReason };

export interface Provider {
  readonly id: string;
  /** Streams a model response. Always terminates with a `done` event. */
  stream(request: ChatRequest): AsyncGenerator<StreamEvent>;
  /** Convenience wrapper that buffers a full response. */
  complete(request: ChatRequest): Promise<ChatResult>;
}

/** Convenience constructors ------------------------------------------------ */

export function textMessage(text: string, role: Role = "user"): Message {
  return { role, content: [{ type: "text", text }], timestamp: new Date().toISOString() };
}

export function messageText(message: Message): string {
  return message.content
    .map((block) => (block.type === "text" ? block.text : ""))
    .filter((part) => part.length > 0)
    .join("");
}

export function toolUses(message: Message): ToolUseBlock[] {
  return message.content.filter((block): block is ToolUseBlock => block.type === "tool_use");
}

export function hasToolResults(message: Message): boolean {
  return message.content.some((block) => block.type === "tool_result");
}

export function emptyUsage(): Usage {
  return { inputTokens: 0, outputTokens: 0 };
}
