/**
 * The agentic loop: stream model output -> execute tools -> feed results back
 * until the model produces a final answer.
 */

import type { Config } from "./config.js";
import type { AgentDefinition } from "../team/agents.js";
import type { Session } from "./session.js";
import type { PermissionDecision, PermissionGate, PermissionRequest } from "./permissions.js";
import { checkPermission, describeTarget } from "./permissions.js";
import type { Provider, Usage, Message, ToolSpec, StopReason, ToolUseBlock } from "./types.js";
import { messageText, textMessage, toolUses } from "./types.js";
import { normalizeMessages } from "./messages.js";
import { compactIfNeeded, contextStatus } from "./context.js";
import { buildSystemPrompt } from "./systemPrompt.js";
import { estimateTokens, TokenCounter } from "../util/tokens.js";
import { costUsd as computeCost } from "../providers/models.js";
import { ProviderError } from "../providers/http.js";
import { findTool, toSpecs, builtinTools } from "../tools/index.js";
import type { Todo, Tool, ToolContext, ToolEvent, ToolResult } from "../tools/types.js";
import { ToolInputError } from "../tools/types.js";

export interface AgentEvents {
  onText?(delta: string): void;
  onAssistantText?(text: string): void;
  onToolStart?(info: { name: string; input: unknown; target?: string; index: number; total: number }): void;
  onToolEnd?(info: {
    name: string;
    target?: string;
    display?: string;
    isError: boolean;
    durationMs: number;
    output: string;
  }): void;
  onPermission?(request: PermissionRequest, decision: PermissionDecision): void;
  onTodos?(todos: Todo[]): void;
  onUsage?(usage: Usage, cumulativeCost: number): void;
  onCompact?(info: { estimatedTokens: number; after: number }): void;
  onLog?(level: "debug" | "info" | "warn" | "error", message: string): void;
  onSubagentStart?(info: { type: string; description: string }): void;
  onSubagentEnd?(info: { type: string; description: string; ok: boolean; durationMs: number }): void;
}

export interface AgentOptions {
  agentDef: AgentDefinition;
  systemPrompt?: string;
  cwd: string;
  config: Config;
  provider: Provider;
  providerId: string;
  model: string;
  tools?: Tool[];
  agents: Map<string, AgentDefinition>;
  session?: Session;
  gate?: PermissionGate;
  interactive: boolean;
  events?: AgentEvents;
  messages?: Message[];
  signal?: AbortSignal;
  parent?: Agent;
  tokenCounter?: TokenCounter;
}

export interface AgentResult {
  text: string;
  turns: number;
  usage: Usage;
  costUsd: number;
  stopReason: StopReason | "max_turns" | "aborted";
}

async function withRetry<T>(fn: () => Promise<T>, signal?: AbortSignal, attempts = 3): Promise<T> {
  let lastError: unknown;
  for (let attempt = 0; attempt < attempts; attempt += 1) {
    if (signal?.aborted) throw new Error("aborted");
    try {
      return await fn();
    } catch (error) {
      lastError = error;
      const retryable =
        error instanceof ProviderError
          ? error.status === 429 || error.status >= 500
          : error instanceof Error && /timed out|network|fetch failed|ECONNRESET/i.test(error.message);
      if (!retryable || attempt === attempts - 1) throw error;
      const delay = 1000 * 2 ** attempt;
      await new Promise((resolve) => setTimeout(resolve, delay));
    }
  }
  throw lastError;
}

export class Agent implements ToolContext {
  readonly cwd: string;
  readonly config: Config;
  readonly sessionId: string;
  readonly interactive: boolean;
  readonly agentName: string;
  readonly signal?: AbortSignal;
  readonly permissionMode: Config["permissionMode"];

  messages: Message[];
  costUsd = 0;
  usage: Usage = { inputTokens: 0, outputTokens: 0 };
  readonly tokens = new TokenCounter();

  private readonly options: AgentOptions;
  private readonly tools: Tool[];
  private systemPrompt: string | null;
  private isSubagent: boolean;

  constructor(options: AgentOptions) {
    this.options = options;
    this.cwd = options.cwd;
    this.config = options.config;
    this.sessionId = options.session?.meta.id ?? "no-session";
    this.interactive = options.interactive;
    this.agentName = options.agentDef.name;
    this.signal = options.signal;
    this.permissionMode = options.agentDef.permissionMode ?? options.config.permissionMode;
    this.messages = options.messages ?? [];
    this.systemPrompt = options.systemPrompt ?? null;
    this.isSubagent = Boolean(options.parent);

    const all = options.tools ?? builtinTools();
    const allowed = options.agentDef.tools;
    this.tools = allowed && allowed.length > 0 ? all.filter((tool) => allowed.includes(tool.spec.name)) : all;
  }

  /* ---------------------------------------------------------------- ToolHost */

  emit(event: ToolEvent): void {
    const events = this.options.events;
    if (event.type === "todos") {
      events?.onTodos?.(event.todos);
      void this.options.session?.setTodos(event.todos);
    } else if (event.type === "log") {
      events?.onLog?.(event.level, event.message);
    } else if (event.type === "progress") {
      // handled by onToolStart consumers; nothing to do here
    } else if (event.type === "background_started") {
      events?.onLog?.("info", `background ${event.id}: ${event.command}`);
    }
  }

  async requestPermission(request: PermissionRequest): Promise<PermissionDecision> {
    const decision = await checkPermission(request, {
      mode: this.permissionMode,
      allow: this.config.allowedTools,
      deny: this.config.disallowedTools,
      gate: this.options.gate,
      interactive: this.interactive,
      cwd: this.cwd,
    });
    this.options.events?.onPermission?.(request, decision);
    return decision;
  }

  write(text: string): void {
    this.options.events?.onLog?.("info", text);
  }

  async spawnSubagent(options: { type: string; prompt: string; model?: string; description: string }): Promise<string> {
    const definition = this.options.agents.get(options.type.toLowerCase());
    if (!definition) {
      const known = [...this.options.agents.keys()].join(", ");
      throw new Error(`Unknown team role "${options.type}". Known roles: ${known}`);
    }
    const startedAt = Date.now();
    this.options.events?.onSubagentStart?.({ type: definition.name, description: options.description });

    const systemPrompt = await buildSystemPrompt({
      cwd: this.cwd,
      config: this.config,
      agent: definition,
      includeWorkspace: true,
    });

    const child = new Agent({
      ...this.options,
      agentDef: definition,
      systemPrompt,
      session: undefined,
      messages: [],
      parent: this,
      model: options.model ?? definition.model ?? this.options.model,
      events: this.subagentEvents(),
    });

    try {
      const result = await child.run(options.prompt);
      this.options.events?.onSubagentEnd?.({
        type: definition.name,
        description: options.description,
        ok: result.stopReason === "end_turn" || result.stopReason === "stop",
        durationMs: Date.now() - startedAt,
      });
      this.costUsd += result.costUsd;
      this.usage = {
        inputTokens: this.usage.inputTokens + result.usage.inputTokens,
        outputTokens: this.usage.outputTokens + result.usage.outputTokens,
      };
      if (result.stopReason === "max_turns") {
        return `${result.text}\n\n[subagent stopped after reaching max turns]`;
      }
      return result.text || "(subagent produced no output)";
    } catch (error) {
      this.options.events?.onSubagentEnd?.({
        type: definition.name,
        description: options.description,
        ok: false,
        durationMs: Date.now() - startedAt,
      });
      throw error;
    }
  }

  private subagentEvents(): AgentEvents {
    const parent = this.options.events;
    return {
      onToolStart: (info) => {
        parent?.onLog?.("info", `\u21b3 ${info.name}(${shortInput(info.input)})`);
      },
      onToolEnd: (info) => {
        if (info.isError) parent?.onLog?.("error", `\u21b3 ${info.name} failed: ${firstLine(info.display ?? info.output)}`);
      },
      onLog: (level, message) => parent?.onLog?.(level, message),
      onTodos: (todos) => parent?.onTodos?.(todos),
      onSubagentStart: (info) => parent?.onLog?.("info", `\u21b3 delegating to ${info.type}: ${info.description}`),
      onSubagentEnd: (info) => parent?.onLog?.(info.ok ? "info" : "error", `\u21b3 ${info.type} ${info.ok ? "finished" : "failed"}`),
    };
  }

  /* ------------------------------------------------------------------- Loop */

  get toolSpecs(): ToolSpec[] {
    return toSpecs(this.tools);
  }

  async ensureSystemPrompt(): Promise<string> {
    if (this.systemPrompt === null) {
      this.systemPrompt = await buildSystemPrompt({ cwd: this.cwd, config: this.config, agent: this.options.agentDef });
    }
    return this.systemPrompt;
  }

  async run(userText: string): Promise<AgentResult> {
    const prompt = userText.trim();
    if (prompt.length > 0) {
      const message = textMessage(prompt);
      this.messages.push(message);
      await this.options.session?.addMessage(message);
    }
    return this.loop();
  }

  async resumeSession(session: Session): Promise<AgentResult> {
    this.messages = [...session.messages];
    return this.loop();
  }

  private async loop(): Promise<AgentResult> {
    const system = await this.ensureSystemPrompt();
    const events = this.options.events;
    const maxTurns = this.options.config.maxTurns;
    const totalUsage: Usage = { inputTokens: 0, outputTokens: 0 };
    let turns = 0;

    while (turns < maxTurns) {
      if (this.signal?.aborted) {
        return this.finish("", turns, totalUsage, "aborted");
      }
      turns += 1;

      // Context budgeting -----------------------------------------------------
      const before = contextStatus(system, this.messages, this.config);
      if (before.ratio > this.options.config.autoCompact) {
        const compacted = await compactIfNeeded(this.messages, {
          provider: this.options.provider,
          model: this.options.model,
          system,
          config: this.options.config,
        });
        if (compacted.changed) {
          this.messages = compacted.messages;
          const after = contextStatus(system, this.messages, this.config);
          events?.onCompact?.({ estimatedTokens: before.estimatedTokens, after: after.estimatedTokens });
          if (this.options.session) await this.options.session.summarize(compacted.summary);
        }
      }

      // Model call ------------------------------------------------------------
      let result;
      try {
        result = await withRetry(
          () =>
            this.options.provider.complete({
              system,
              messages: normalizeMessages(this.messages),
              tools: this.toolSpecs,
              model: this.options.model,
              temperature: this.options.config.temperature,
              maxTokens: Math.min(this.options.config.maxTokens, this.options.config.contextWindow),
              ...(this.signal ? { signal: this.signal } : {}),
            }),
          this.signal,
        );
      } catch (error) {
        if (this.signal?.aborted) return this.finish("", turns, totalUsage, "aborted");
        const message = error instanceof Error ? error.message : String(error);
        events?.onLog?.("error", message);
        await this.options.session?.note("error", message);
        return this.finish("", turns, totalUsage, "error", message);
      }

      totalUsage.inputTokens += result.usage.inputTokens;
      totalUsage.outputTokens += result.usage.outputTokens;
      this.tokens.addUsage(result.usage);
      this.costUsd += computeCost(this.options.model, this.options.providerId, result.usage);
      events?.onUsage?.(result.usage, this.costUsd);

      this.messages.push(result.message);
      await this.options.session?.addMessage(result.message);

      const assistantText = messageText(result.message);
      if (assistantText) events?.onAssistantText?.(assistantText);

      const uses = toolUses(result.message);
      if (uses.length === 0) {
        return this.finish(assistantText, turns, totalUsage, result.stopReason);
      }

      // Tool execution --------------------------------------------------------
      const toolResults = await this.executeTools(uses);
      const response: Message = { role: "user", content: toolResults, timestamp: new Date().toISOString() };
      this.messages.push(response);
      await this.options.session?.addMessage(response);

      if (this.signal?.aborted) return this.finish("", turns, totalUsage, "aborted");
    }

    const notice =
      `Reached the maximum of ${maxTurns} tool iterations for this turn without a final answer. ` +
      `Continue by replying "continue", or raise max_turns in .aet/config.json.`;
    events?.onLog?.("warn", notice);
    return this.finish(notice, turns, totalUsage, "max_turns");
  }

  private async executeTools(uses: ToolUseBlock[]): Promise<Array<{ type: "tool_result"; toolUseId: string; content: string; isError?: boolean }>> {
    const results: Array<{ type: "tool_result"; toolUseId: string; content: string; isError?: boolean }> = [];
    const events = this.options.events;

    for (const [index, use] of uses.entries()) {
      const target = describeTarget(use.name, use.input);
      events?.onToolStart?.({ name: use.name, input: use.input, ...(target ? { target } : {}), index: index + 1, total: uses.length });

      if (this.signal?.aborted) {
        results.push({ type: "tool_result", toolUseId: use.id, content: "Aborted by user.", isError: true });
        continue;
      }

      const decision = await this.requestPermission({
        tool: use.name,
        input: use.input,
        ...(target ? { target } : {}),
        source: this.isSubagent ? "subagent" : "main",
      });
      events?.onPermission?.({ tool: use.name, input: use.input, ...(target ? { target } : {}) }, decision);

      if (decision.action === "deny") {
        const reason = `Permission denied for ${use.name}${target ? ` (${target})` : ""}: ${decision.reason ?? "denied by policy"}`;
        results.push({ type: "tool_result", toolUseId: use.id, content: reason, isError: true });
        events?.onToolEnd?.({
          name: use.name,
          ...(target ? { target } : {}),
          isError: true,
          durationMs: 0,
          output: reason,
        });
        continue;
      }

      const tool = findTool(this.tools, use.name);
      if (!tool) {
        const reason = `Unknown tool "${use.name}". Available: ${this.tools.map((t) => t.spec.name).join(", ")}`;
        results.push({ type: "tool_result", toolUseId: use.id, content: reason, isError: true });
        continue;
      }

      const startedAt = Date.now();
      let output: string;
      let isError = false;
      let display: string | undefined;
      try {
        const toolResult: ToolResult = await tool.execute(use.input, this);
        output = toolResult.output;
        isError = toolResult.isError ?? false;
        display = toolResult.display;
      } catch (error) {
        isError = true;
        output =
          error instanceof ToolInputError
            ? `Invalid input for ${use.name}: ${error.message}`
            : `${use.name} failed: ${error instanceof Error ? error.message : String(error)}`;
      }
      const durationMs = Date.now() - startedAt;
      results.push({ type: "tool_result", toolUseId: use.id, content: output, isError });
      events?.onToolEnd?.({
        name: use.name,
        ...(target ? { target } : {}),
        ...(display ? { display } : {}),
        isError,
        durationMs,
        output,
      });
    }

    return results;
  }

  private finish(
    text: string,
    turns: number,
    usage: Usage,
    stopReason: StopReason | "max_turns" | "aborted",
    error?: string,
  ): AgentResult {
    if (error) this.options.events?.onLog?.("error", error);
    return { text, turns, usage, costUsd: this.costUsd, stopReason };
  }

  /** Rough token footprint of the current conversation. */
  contextEstimate(): number {
    return estimateTokens(this.messages.map((message) => JSON.stringify(message.content)).join("\n"));
  }

  /** Estimated tokens including the system prompt (used by the status line). */
  contextTokens(): number {
    return estimateTokens(this.systemPrompt ?? "") + this.contextEstimate() + 400;
  }
}

function shortInput(input: unknown): string {
  const json = JSON.stringify(input) ?? "";
  return json.length > 90 ? `${json.slice(0, 89)}\u2026` : json;
}

function firstLine(text: string): string {
  return text.split("\n")[0] ?? "";
}
