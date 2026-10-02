/**
 * Deterministic offline provider.
 *
 * Used by the test-suite, `aet doctor` and demos (`--provider mock`) so the
 * whole agentic loop - tools, permissions, sessions - runs without any API
 * key. Drive it with `AET_MOCK_SCRIPT=/path/to/script.json`:
 *
 *   [
 *     { "text": "I will create the file." },
 *     { "toolCalls": [{ "name": "Write", "input": { "file_path": "a.txt", "content": "hi" } }] },
 *     { "text": "Done." }
 *   ]
 */

import * as fs from "node:fs";
import type {
  ChatRequest,
  ChatResult,
  Message,
  Provider,
  StopReason,
  StreamEvent,
  ToolUseBlock,
  Usage,
} from "../core/types.js";

interface MockStep {
  text?: string;
  toolCalls?: Array<{ id?: string; name: string; input: unknown }>;
  stopReason?: StopReason;
  usage?: Partial<Usage>;
}

export interface MockOptions {
  scriptPath?: string;
  debug?: (message: string, extra?: unknown) => void;
}

export class MockProvider implements Provider {
  readonly id = "mock";
  private readonly steps: MockStep[];
  private cursor = 0;
  private readonly debug?: (message: string, extra?: unknown) => void;

  constructor(options: MockOptions = {}) {
    this.debug = options.debug;
    const scriptPath = options.scriptPath ?? process.env.AET_MOCK_SCRIPT;
    this.steps = loadScript(scriptPath);
  }

  private nextStep(request: ChatRequest): MockStep {
    if (this.cursor >= this.steps.length) {
      const lastUser = [...request.messages].reverse().find((message) => message.role === "user");
      const prompt = lastUser?.content.find((block) => block.type === "text");
      return {
        text: `[mock] ${prompt && prompt.type === "text" ? prompt.text : "no prompt"}`,
        stopReason: "end_turn",
      };
    }
    const step = this.steps[this.cursor]!;
    this.cursor += 1;
    return step;
  }

  async *stream(request: ChatRequest): AsyncGenerator<StreamEvent> {
    const step = this.nextStep(request);
    const content: Message["content"] = [];
    let text = step.text ?? "";
    if (text.length > 0) {
      content.push({ type: "text", text });
      // Emit in chunks so streaming UIs are exercised.
      const words = text.split(/(?<=\s)/);
      for (const word of words) yield { type: "text", text: word };
    }
    const toolUses: ToolUseBlock[] = (step.toolCalls ?? []).map((call, index) => ({
      type: "tool_use",
      id: call.id ?? `mock_tool_${index}_${Date.now().toString(36)}`,
      name: call.name,
      input: call.input,
    }));
    content.push(...toolUses);

    const usage: Usage = {
      inputTokens: step.usage?.inputTokens ?? estimate(request),
      outputTokens: step.usage?.outputTokens ?? Math.ceil(text.length / 4),
      cacheReadTokens: 0,
      cacheWriteTokens: 0,
    };
    const stopReason: StopReason = step.stopReason ?? (toolUses.length > 0 ? "tool_use" : "end_turn");
    const message: Message = { role: "assistant", content, model: request.model, timestamp: new Date().toISOString() };
    this.debug?.("mock step", { cursor: this.cursor, tools: toolUses.length });
    yield { type: "done", message, usage, stopReason };
  }

  async complete(request: ChatRequest): Promise<ChatResult> {
    for await (const event of this.stream(request)) {
      if (event.type === "done") {
        return { message: event.message, usage: event.usage, stopReason: event.stopReason };
      }
    }
    throw new Error("mock stream ended without a result");
  }
}

function estimate(request: ChatRequest): number {
  const body = JSON.stringify(request.messages);
  return Math.max(1, Math.ceil((request.system.length + body.length) / 4));
}

function loadScript(scriptPath?: string): MockStep[] {
  if (!scriptPath) return [];
  try {
    const raw = fs.readFileSync(scriptPath, "utf8");
    const parsed = JSON.parse(raw) as MockStep[];
    if (!Array.isArray(parsed)) throw new Error("mock script must be an array");
    return parsed;
  } catch (error) {
    throw new Error(`Unable to load mock script: ${(error as Error).message}`);
  }
}
