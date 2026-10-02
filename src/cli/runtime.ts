/** Shared runtime: wires config, credentials, MCP tools, sessions and agents. */

import * as path from "node:path";
import { loadConfig, type Config, type PermissionMode } from "../core/config.js";
import { resolveAgents, getAgent, type AgentDefinition } from "../team/agents.js";
import { resolveProvider, type ProviderId } from "../providers/index.js";
import type { Provider } from "../core/types.js";
import { builtinTools } from "../tools/index.js";
import type { Tool } from "../tools/types.js";
import { McpRegistry, type McpServerStatus } from "../mcp/client.js";
import { loadMcpServers } from "../mcp/config.js";
import { Session } from "../core/session.js";
import { QueuedGate } from "../ui/prompt.js";
import type { PermissionGate } from "../core/permissions.js";
import { buildSystemPrompt } from "../core/systemPrompt.js";
import { Agent, type AgentEvents } from "../core/agent.js";
import { setColorEnabled } from "../util/color.js";
import { splitList } from "../util/text.js";
import type { ParsedArgs } from "./args.js";
import { optionBool, optionNumber, optionString } from "./args.js";
import { ensureDir } from "../util/fsx.js";
import { getPaths } from "../core/paths.js";

export interface RuntimeCreateOptions {
  cwd: string;
  args: ParsedArgs;
  interactive: boolean;
  events?: AgentEvents;
  /** Skip MCP startup (fast one-shot commands). */
  skipMcp?: boolean;
}

export class Runtime {
  readonly cwd: string;
  readonly config: Config;
  readonly agents: Map<string, AgentDefinition>;
  readonly tools: Tool[];
  /** Mutable so `/model` can swap providers mid-session. */
  provider: Provider;
  providerId: ProviderId;
  model: string;
  readonly interactive: boolean;
  readonly events?: AgentEvents;
  readonly appendSystemPrompt?: string;

  session?: Session;
  gate?: PermissionGate;
  mcpStatus: McpServerStatus[] = [];

  private readonly registry?: McpRegistry;

  private constructor(init: {
    cwd: string;
    config: Config;
    agents: Map<string, AgentDefinition>;
    tools: Tool[];
    provider: Provider;
    providerId: ProviderId;
    model: string;
    interactive: boolean;
    events?: AgentEvents;
    registry?: McpRegistry;
    appendSystemPrompt?: string;
  }) {
    this.cwd = init.cwd;
    this.config = init.config;
    this.agents = init.agents;
    this.tools = init.tools;
    this.provider = init.provider;
    this.providerId = init.providerId;
    this.model = init.model;
    this.interactive = init.interactive;
    this.events = init.events;
    this.registry = init.registry;
    this.appendSystemPrompt = init.appendSystemPrompt;
  }

  static async create(options: RuntimeCreateOptions): Promise<Runtime> {
    const { cwd, args, interactive } = options;
    await ensureDir(getPaths().home);

    const overrides = overridesFromArgs(args);
    const config = await loadConfig({ cwd, ...(Object.keys(overrides).length > 0 ? { overrides } : {}) });
    setColorEnabled(config.color);

    const agents = await resolveAgents(cwd);
    const { provider, providerId, model } = await resolveProvider({
      model: config.model,
      ...(config.provider ? { provider: config.provider } : {}),
      debug: config.debug,
    });

    // MCP -------------------------------------------------------------------
    let tools = builtinTools();
    let registry: McpRegistry | undefined;
    if (config.mcpEnabled && options.skipMcp !== true) {
      const servers = { ...(await loadMcpServers(cwd)), ...config.mcpServers };
      if (Object.keys(servers).length > 0) {
        registry = new McpRegistry(servers);
        try {
          const started = await registry.start();
          tools = [...tools, ...started.tools];
          if (options.events) {
            for (const status of started.status) {
              if (status.status === "failed") {
                options.events.onLog?.("warn", `MCP server "${status.name}" failed: ${status.error ?? "unknown error"}`);
              } else if (config.verbose) {
                options.events.onLog?.("info", `MCP server "${status.name}" ready (${status.tools} tools)`);
              }
            }
          }
        } catch (error) {
          options.events?.onLog?.("warn", `MCP startup failed: ${(error as Error).message}`);
        }
      }
    }

    const runtime = new Runtime({
      cwd,
      config,
      agents,
      tools,
      provider,
      providerId,
      model,
      interactive,
      ...(options.events ? { events: options.events } : {}),
      ...(registry ? { registry } : {}),
      ...(overrides.appendSystemPrompt ? { appendSystemPrompt: overrides.appendSystemPrompt } : {}),
    });

    if (interactive) {
      runtime.gate = new QueuedGate(() => runtime.requireReadline(), {
        onRemember: async (rule) => {
          const { saveUserConfig } = await import("../core/config.js");
          const updated = await saveUserConfig({ allowedTools: [...config.allowedTools, rule] });
          config.allowedTools = updated.allowedTools;
        },
      });
    }

    await runtime.setupSession(args);
    return runtime;
  }

  private rl?: import("node:readline").Interface;

  /** Register the terminal once the REPL has attached its listeners. */
  setReadline(rl: import("node:readline").Interface): void {
    this.rl = rl;
  }

  getReadline(): import("node:readline").Interface | undefined {
    return this.rl;
  }

  /** Used by the permission gate; throws when no terminal is attached. */
  requireReadline(): import("node:readline").Interface {
    if (!this.rl) throw new Error("terminal not ready");
    return this.rl;
  }

  private async setupSession(args: ParsedArgs): Promise<void> {
    const resumeId = optionString(args, "resume");
    const continueLast = optionBool(args, "continue");

    if (continueLast) {
      const latest = await Session.latestForCwd(this.cwd);
      if (latest) {
        this.session = (await Session.load(latest.id)) ?? undefined;
      }
      if (!this.session) throw new Error(`No previous session found for ${this.cwd}`);
      return;
    }
    if (resumeId !== undefined && resumeId !== "") {
      const session = await Session.load(resumeId);
      if (!session) throw new Error(`Session "${resumeId}" not found (see \`aet sessions list\`)`);
      this.session = session;
      return;
    }
    this.session = await Session.create({ cwd: this.cwd, model: this.model, agent: this.config.agent });
  }

  async resumeSessionById(id: string): Promise<void> {
    const session = await Session.load(id);
    if (!session) throw new Error(`Session "${id}" not found`);
    this.session = session;
  }

  /** Create an agent bound to this runtime (and optionally a session). */
  async createAgent(options: { agentName?: string; session?: Session | null; signal?: AbortSignal } = {}): Promise<Agent> {
    const name = (options.agentName ?? this.config.agent).toLowerCase();
    const agentDef = getAgent(this.agents, name) ?? getAgent(this.agents, "general")!;
    if (!getAgent(this.agents, name)) {
      this.events?.onLog?.("warn", `Unknown agent "${name}" - using "general". See \`aet agents\`.`);
    }

    const systemPrompt = await buildSystemPrompt({
      cwd: this.cwd,
      config: this.config,
      agent: agentDef,
      ...(this.appendSystemPrompt ? { append: this.appendSystemPrompt } : {}),
    });

    const session = options.session === undefined ? this.session : options.session ?? undefined;

    return new Agent({
      agentDef,
      systemPrompt,
      cwd: this.cwd,
      config: this.config,
      provider: this.provider,
      providerId: this.providerId,
      model: agentDef.model ?? this.model,
      tools: this.tools,
      agents: this.agents,
      ...(session ? { session } : {}),
      ...(this.gate ? { gate: this.gate } : {}),
      interactive: this.interactive,
      ...(this.events ? { events: this.events } : {}),
      ...(options.signal ? { signal: options.signal } : {}),
      ...(session ? { messages: [...session.messages] } : {}),
    });
  }

  async close(): Promise<void> {
    await this.registry?.stop();
  }
}

interface OverridesFromArgs {
  model?: string;
  provider?: string;
  agent?: string;
  permissionMode?: PermissionMode;
  allowedTools?: string[];
  disallowedTools?: string[];
  maxTurns?: number;
  maxTokens?: number;
  temperature?: number;
  verbose?: boolean;
  debug?: boolean;
  color?: boolean;
  appendSystemPrompt?: string;
}

export function overridesFromArgs(args: ParsedArgs): OverridesFromArgs {
  const overrides: OverridesFromArgs = {};

  const model = optionString(args, "model");
  if (model) overrides.model = model;
  const provider = optionString(args, "provider");
  if (provider) overrides.provider = provider;
  const agent = optionString(args, "agent");
  if (agent) overrides.agent = agent;

  if (optionBool(args, "dangerously-skip-permissions")) overrides.permissionMode = "bypassPermissions";
  else if (optionBool(args, "plan")) overrides.permissionMode = "plan";
  else if (optionBool(args, "accept-edits")) overrides.permissionMode = "acceptEdits";
  else {
    const mode = optionString(args, "permission-mode");
    if (mode) overrides.permissionMode = mode as PermissionMode;
  }

  const allowed = optionString(args, "allowed-tools");
  if (allowed) overrides.allowedTools = [...splitList(allowed)];
  const denied = optionString(args, "disallowed-tools");
  if (denied) overrides.disallowedTools = [...splitList(denied)];

  const maxTurns = optionNumber(args, "max-turns");
  if (maxTurns !== undefined) overrides.maxTurns = maxTurns;
  const maxTokens = optionNumber(args, "max-tokens");
  if (maxTokens !== undefined) overrides.maxTokens = maxTokens;
  const temperature = optionNumber(args, "temperature");
  if (temperature !== undefined) overrides.temperature = temperature;

  if (optionBool(args, "verbose")) overrides.verbose = true;
  if (optionBool(args, "debug")) overrides.debug = true;
  if (optionBool(args, "no-color")) overrides.color = false;
  const append = optionString(args, "append-system-prompt");
  if (append) overrides.appendSystemPrompt = append;

  return overrides;
}

/** Convenience: resolve a session id or alias relative to a cwd. */
export function normalizeCwd(cwdFlag?: string): string {
  return path.resolve(cwdFlag ?? process.cwd());
}
