/** Context-window budgeting and auto-compaction. */

import type { Config } from "./config.js";
import type { Message, Provider } from "./types.js";
import { estimateTokens } from "../util/tokens.js";
import { describeMessage } from "./messages.js";

export interface ContextStatus {
  estimatedTokens: number;
  contextWindow: number;
  /** 0..1 */
  ratio: number;
}

export function estimateRequestTokens(system: string, messages: Message[]): number {
  let total = estimateTokens(system) + 64; // tools + framing
  for (const message of messages) {
    total += estimateTokens(JSON.stringify(message.content)) + 8;
  }
  return total;
}

export function contextStatus(system: string, messages: Message[], config: Config): ContextStatus {
  const estimatedTokens = estimateRequestTokens(system, messages);
  return { estimatedTokens, contextWindow: config.contextWindow, ratio: estimatedTokens / config.contextWindow };
}

export interface CompactResult {
  messages: Message[];
  summary: string;
  changed: boolean;
}

/** Find a safe split point: a real user turn (text, not a tool_result). */
function findSplitIndex(messages: Message[], target: number): number {
  for (let index = target; index < messages.length - 1; index += 1) {
    const message = messages[index]!;
    if (message.role !== "user") continue;
    const first = message.content[0];
    if (first?.type === "text") return index;
  }
  for (let index = target; index >= 1; index -= 1) {
    const message = messages[index]!;
    if (message.role === "user" && message.content[0]?.type === "text") return index;
  }
  return -1;
}

export interface CompactorOptions {
  provider: Provider;
  model: string;
  system: string;
  config: Config;
  /** Compact even when under the auto-compact threshold (manual /compact). */
  force?: boolean;
  debug?: (message: string) => void;
}

/**
 * Compact the conversation when it exceeds the auto-compact threshold:
 * 1. Summarize the oldest turns with the model (structured summary).
 * 2. Fall back to truncating old tool results if that call fails.
 */
export async function compactIfNeeded(messages: Message[], options: CompactorOptions): Promise<CompactResult> {
  const { config, system } = options;
  const before = estimateRequestTokens(system, messages);
  const budget = config.contextWindow * config.autoCompact;

  if (before <= budget && !options.force) {
    return { messages, summary: "", changed: false };
  }

  const tailTarget = Math.floor(messages.length * 0.4);
  const splitIndex = findSplitIndex(messages, Math.max(1, tailTarget));

  if (splitIndex > 0) {
    const head = messages.slice(0, splitIndex);
    const tail = messages.slice(splitIndex);
    try {
      const summary = await summarize(head, options);
      const summaryMessage: Message = {
        role: "user",
        content: [
          {
            type: "text",
            text:
              "<conversation-compacted>\n" +
              "Earlier turns were compacted to save context. Summary of what happened so far:\n\n" +
              summary +
              "\n\nContinue from this state. Current turn follows.\n</conversation-compacted>",
          },
        ],
        timestamp: new Date().toISOString(),
      };
      const next = [summaryMessage, ...tail];
      const after = estimateRequestTokens(system, next);
      options.debug?.(`compacted ${head.length} messages: ${before} -> ~${after} tokens`);
      return { messages: next, summary, changed: true };
    } catch (error) {
      options.debug?.(`compaction summary failed: ${(error as Error).message}; falling back to truncation`);
    }
  }

  // Fallback: shrink old tool results / assistant text in place.
  const next = truncateHistory(messages);
  const after = estimateRequestTokens(system, next);
  options.debug?.(`compacted by truncation: ${before} -> ~${after} tokens`);
  return { messages: next, summary: "Truncated earlier tool outputs to fit the context window.", changed: true };
}

async function summarize(head: Message[], options: CompactorOptions): Promise<string> {
  const transcript = head
    .map((message) => `### ${message.role.toUpperCase()}\n${describeMessage(message, 4000)}`)
    .join("\n\n");

  const result = await options.provider.complete({
    system:
      "You compress conversation history for an agentic coding CLI. Produce a dense, factual handover note. " +
      "Include: the user's goal, decisions made, files created/modified (with paths and key contents), commands run and their results, " +
      "errors encountered, and the exact state of any in-progress work plus next steps. " +
      "Do not add commentary. Plain text, at most 600 words.",
    messages: [
      {
        role: "user",
        content: [{ type: "text", text: `Compress this transcript:\n\n${transcript}` }],
      },
    ],
    tools: [],
    model: options.config.summarizeModel ?? options.model,
    maxTokens: 2000,
  });

  const text = result.message.content
    .map((block) => (block.type === "text" ? block.text : ""))
    .filter(Boolean)
    .join("\n")
    .trim();
  if (!text) throw new Error("empty summary");
  return text;
}

/** Fallback strategy: keep recent turns, shrink older tool output. */
function truncateHistory(messages: Message[], keepRecent = 6): Message[] {
  const cutoff = Math.max(0, messages.length - keepRecent);
  return messages.map((message, index) => {
    if (index >= cutoff) return message;
    return {
      ...message,
      content: message.content.map((block) => {
        if (block.type === "tool_result" && block.content.length > 600) {
          return { ...block, content: `${block.content.slice(0, 600)}\n\u2026 [truncated for context]` };
        }
        if (block.type === "text" && block.text.length > 1500 && index < cutoff - 2) {
          return { ...block, text: `${block.text.slice(0, 1500)}\n\u2026 [truncated]` };
        }
        return block;
      }),
    };
  });
}
