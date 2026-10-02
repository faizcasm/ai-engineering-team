/** Message helpers: normalization and serialization for transcripts. */

import type { ContentBlock, Message, Usage } from "./types.js";
import { messageText } from "./types.js";

/**
 * Providers require alternating roles. Merge consecutive messages of the
 * same role (which happens after compaction or when a user sends two
 * messages back to back).
 */
export function normalizeMessages(messages: Message[]): Message[] {
  const out: Message[] = [];
  for (const message of messages) {
    const previous = out[out.length - 1];
    if (previous && previous.role === message.role) {
      previous.content = [...previous.content, ...message.content];
      continue;
    }
    out.push({ ...message, content: [...message.content] });
  }
  // Anthropic requires the conversation to start with a user message.
  while (out.length > 0 && out[0]!.role !== "user") out.shift();
  return out;
}

export function summarizeUsage(a: Usage, b: Usage): Usage {
  return {
    inputTokens: a.inputTokens + b.inputTokens,
    outputTokens: a.outputTokens + b.outputTokens,
    cacheReadTokens: (a.cacheReadTokens ?? 0) + (b.cacheReadTokens ?? 0),
    cacheWriteTokens: (a.cacheWriteTokens ?? 0) + (b.cacheWriteTokens ?? 0),
  };
}

/** Compact transcript rendering used for logs, `/context` and compaction. */
export function describeMessage(message: Message, maxChars = 400): string {
  const parts: string[] = [];
  for (const block of message.content) {
    if (block.type === "text") {
      parts.push(truncate(block.text, maxChars));
    } else if (block.type === "tool_use") {
      parts.push(`[tool_use ${block.name} ${truncate(JSON.stringify(block.input), maxChars)}]`);
    } else {
      parts.push(`[tool_result ${truncate(block.content, maxChars)}]`);
    }
  }
  return parts.join("\n");
}

function truncate(text: string, max: number): string {
  return text.length <= max ? text : `${text.slice(0, max)}\u2026`;
}

/** Flatten a message list into plain text (used by compaction summaries). */
export function messagesToTranscript(messages: Message[]): string {
  return messages
    .map((message) => {
      const body = describeMessage(message, 2000);
      return `## ${message.role}\n${body}`;
    })
    .join("\n\n");
}

export function firstText(message: Message): string {
  return messageText(message);
}

export function contentOf(blocks: ContentBlock[]): string {
  return blocks
    .map((block) => (block.type === "text" ? block.text : block.type === "tool_result" ? block.content : JSON.stringify(block.input)))
    .join("\n");
}
