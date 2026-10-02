/** The interactive REPL: status line, tool rendering, slash commands, approvals. */

import * as path from "node:path";
import * as fs from "node:fs/promises";
import * as readline from "node:readline";

import type { Runtime } from "../cli/runtime.js";
import type { ParsedArgs } from "../cli/args.js";
import type { Agent, AgentEvents, AgentResult } from "../core/agent.js";
import type { PermissionMode } from "../core/config.js";
import { PERMISSION_MODES, saveUserConfig } from "../core/config.js";
import { checkPermission, suggestAllowRule } from "../core/permissions.js";
import { Session } from "../core/session.js";
import { compactIfNeeded } from "../core/context.js";
import { getAgent } from "../team/agents.js";
import { formatTeamReport, runTeam } from "../team/orchestrator.js";
import { runCommand } from "../tools/bash.js";
import type { Todo } from "../tools/types.js";
import { loadCustomCommands, expandCommand, expandFileReferences, type CustomCommand } from "../slash/commands.js";
import { listModels } from "../providers/models.js";
import { loadMcpServers, mcpFileFor } from "../mcp/config.js";
import { pingServer } from "../mcp/client.js";
import { style, setColorEnabled, isColorEnabled } from "../util/color.js";
import { humanDuration, truncateEnd } from "../util/text.js";
import { renderMarkdown, renderText } from "./markdown.js";
import { Spinner } from "./spinner.js";
import { choose, setLineProvider } from "./prompt.js";
import { renderCommandHelp, renderVersion } from "../cli/help.js";
import { VERSION, CREDIT } from "../version.js";

const CONTINUATION = "\\";

export class Repl {
  private rl!: readline.Interface;
  private readonly spinner: Spinner;
  private readonly args: ParsedArgs;
  private agent!: Agent;
  private controller?: AbortController;
  private customCommands = new Map<string, CustomCommand>();
  private todos: Todo[] = [];
  private running = false;
  private lastSigint = 0;
  private interruptHintShown = false;

  constructor(
    private readonly runtime: Runtime,
    args: ParsedArgs,
  ) {
    this.args = args;
    this.spinner = new Spinner({ enabled: Boolean(process.stderr.isTTY) && !optionBoolQuiet(args) });
  }

  async start(initialPrompt?: string): Promise<void> {
    // Create the terminal and attach listeners synchronously so input that
    // arrives immediately (piped/expect-driven sessions) is never lost.
    this.rl = readline.createInterface({
      input: process.stdin,
      output: process.stdout,
      terminal: Boolean(process.stdin.isTTY),
    });
    this.runtime.setReadline(this.rl);
    this.setupInput();
    // Prompts (approvals, menus) read from the same queue as the main loop.
    setLineProvider(() => this.nextLine());

    this.agent = await this.runtime.createAgent();
    this.customCommands = await loadCustomCommands(this.runtime.cwd);
    this.wireSignals();

    this.printWelcome();

    if (initialPrompt && initialPrompt.trim().length > 0) {
      await this.runTurn(initialPrompt.trim());
    }

    let buffer = "";
    // Drain any input that arrived before (or while) the welcome banner printed.
    while (!this.closed || this.lineQueue.length > 0) {
      if (buffer.length === 0) this.printPrompt();
      else this.printContinuationPrompt();

      const line = await this.nextLine();
      if (line === null) break;

      if (buffer.length > 0) {
        if (line.trim() === ".") {
          const combined = buffer.trimEnd();
          buffer = "";
          if ((await this.handleLine(combined)) === "exit") break;
          continue;
        }
        buffer += `\n${line}`;
        if (line.endsWith(CONTINUATION)) {
          buffer = buffer.slice(0, -1);
          continue;
        }
        const combined = buffer;
        buffer = "";
        if ((await this.handleLine(combined)) === "exit") break;
        continue;
      }

      if (line.endsWith(CONTINUATION) && line.trim().length > 1) {
        buffer = line.slice(0, -1);
        continue;
      }
      if ((await this.handleLine(line)) === "exit") break;
    }

    this.shutdown();
  }

  /* ------------------------------------------------------------- plumbing */

  private lineQueue: string[] = [];
  private lineWaiter: ((line: string | null) => void) | null = null;
  private closed = false;

  private setupInput(): void {
    this.rl.on("line", (line) => {
      // Single consumer at a time: prompts (approvals/menus) and the main loop
      // both read through nextLine(), so typed-ahead input is queued here and
      // consumed by whoever is waiting - never dropped, never read twice.
      const waiter = this.lineWaiter;
      if (waiter) {
        this.lineWaiter = null;
        waiter(line);
      } else {
        this.lineQueue.push(line);
      }
    });
    this.rl.on("close", () => {
      this.closed = true;
      const waiter = this.lineWaiter;
      if (waiter) {
        this.lineWaiter = null;
        waiter(null);
      }
    });
  }

  private nextLine(): Promise<string | null> {
    if (this.lineQueue.length > 0) return Promise.resolve(this.lineQueue.shift() ?? null);
    if (this.closed) return Promise.resolve(null);
    return new Promise<string | null>((resolve) => {
      this.lineWaiter = resolve;
    });
  }

  private printPrompt(): void {
    if (this.closed) return;
    try {
      this.rl.setPrompt(this.statusLine());
      this.rl.prompt();
    } catch {
      /* interface closed mid-flight */
    }
  }

  private printContinuationPrompt(): void {
    if (this.closed) return;
    try {
      this.rl.setPrompt(`${style.dim("... ")} `);
      this.rl.prompt();
    } catch {
      /* ignore */
    }
  }

  private wireSignals(): void {
    this.rl.on("SIGINT", () => {
      if (this.running && this.controller) {
        this.controller.abort(new Error("interrupted"));
        process.stderr.write(`\n${style.yellow("interrupting\u2026 (Ctrl+C again to force quit)")}\n`);
        if (this.lastSigint && Date.now() - this.lastSigint < 1500) {
          process.exit(130);
        }
        this.lastSigint = Date.now();
        return;
      }
      const now = Date.now();
      if (this.interruptHintShown && now - this.lastSigint < 2000) {
        process.exit(130);
      }
      this.lastSigint = now;
      this.interruptHintShown = true;
      process.stderr.write(`\n${style.dim("press Ctrl+C again to exit, Ctrl+D or /exit to quit")}\n`);
      this.rl.prompt(true);
    });
  }

  private shutdown(): void {
    this.spinner.clear();
    setLineProvider(null);
    this.rl.close();
    void this.runtime.close();
    process.stdout.write(`\n${style.dim(`session saved \u00b7 ${CREDIT}`)}\n`);
  }

  private statusLine(): string {
    const cfg = this.runtime.config;
    const color = isColorEnabled();
    const agent = color ? style.cyan(this.agent?.agentName ?? cfg.agent) : (this.agent?.agentName ?? cfg.agent);
    const mode = cfg.permissionMode === "default" ? "" : color ? style.yellow(` ${cfg.permissionMode}`) : ` ${cfg.permissionMode}`;
    const model = color ? style.dim(`[${this.runtime.model}] `) : `[${this.runtime.model}] `;
    const parts: string[] = [];
    if (this.agent) {
      const ratio = Math.min(1, this.agent.contextTokens() / cfg.contextWindow);
      if (ratio > 0.05 || this.agent.costUsd > 0) {
        const ctx = `${Math.round(ratio * 100)}%`;
        const cost = this.agent.costUsd > 0 ? ` $${this.agent.costUsd.toFixed(3)}` : "";
        parts.push(color ? style.dim(`${ctx}${cost}`) : `${ctx}${cost}`);
      }
    }
    const suffix = parts.length > 0 ? ` ${style.dim("\u27e6")}${parts.join(" ")}${style.dim("\u27e7")}` : "";
    return `${model}${agent}${mode}>${suffix} `;
  }

  private printWelcome(): void {
    if (this.args.options.quiet === true) return;
    const color = isColorEnabled();
    const lines: string[] = [];
    lines.push(
      color
        ? `${style.bold(style.cyan("AI Engineering Team"))} ${style.dim(`v${VERSION}`)} ${style.dim("\u00b7 aet")}`
        : `AI Engineering Team v${VERSION} . aet`,
    );
    lines.push(style.dim(`  ${CREDIT} \u00b7 MIT \u00b7 https://github.com/faizcasm/ai-engineering-team`));
    const sessionInfo = this.runtime.session
      ? `session ${this.runtime.session.meta.id} \u00b7 ${this.runtime.session.messages.length} messages`
      : "new session";
    lines.push(
      style.dim(
        `  model ${this.runtime.model} \u00b7 agent ${this.runtime.config.agent} \u00b7 mode ${this.runtime.config.permissionMode} \u00b7 ${sessionInfo}`,
      ),
    );
    if (this.runtime.session && this.runtime.session.messages.length > 0) {
      const origin = this.runtime.session.meta.cwd;
      const relative = path.relative(this.runtime.cwd, origin);
      // Fall back to the absolute path when the session belongs to another tree.
      const location = relative && !relative.startsWith("..") ? relative : origin;
      lines.push(style.green(`  resumed ${location || this.runtime.cwd} conversation`));
    }
    lines.push(style.dim(`  /help for commands \u00b7 !cmd for shell \u00b7 @file to inline a file \u00b7 Ctrl+C to interrupt`));
    if (this.runtime.config.permissionMode === "bypassPermissions") {
      lines.push(style.yellow("  \u26a0 bypassPermissions: no approvals will be requested"));
    }
    process.stdout.write(`\n${lines.join("\n")}\n\n`);
  }

  /* ----------------------------------------------------------- input line */

  private async handleLine(rawLine: string): Promise<"ok" | "exit"> {
    const line = rawLine.trim();
    if (line.length === 0) return "ok";

    if (line === "!exit") return "exit";

    if (line.startsWith("/")) {
      return this.handleSlash(line);
    }

    if (line.startsWith("!")) {
      await this.runShell(line.slice(1).trim());
      return "ok";
    }

    // @agent-name prompt  -> temporarily switch role
    let prompt = line;
    const mention = /^@([a-z0-9\-_]+)\s+(.*)$/i.exec(line);
    if (mention) {
      const name = mention[1]!.toLowerCase();
      if (getAgent(this.runtime.agents, name)) {
        await this.switchAgent(name, false);
        prompt = mention[2]!;
      }
    }

    await this.runTurn(await expandFileReferences(prompt, this.runtime.cwd));
    return "ok";
  }

  /* --------------------------------------------------------------- turns */

  private events(): AgentEvents {
    return {
      onToolStart: (info) => {
        const target = info.target ? ` ${style.dim(truncateEnd(info.target, 70))}` : "";
        this.spinner.start(`${info.name}${target}`);
      },
      onToolEnd: (info) => {
        this.spinner.stop();
        const icon = info.isError ? style.red("\u25cf") : style.cyan("\u25cf");
        const label = `${info.name}${info.target ? ` ${style.white(truncateEnd(info.target, 70))}` : ""}`;
        const meta = style.dim(` \u00b7 ${info.display ?? humanDuration(info.durationMs)}`);
        process.stdout.write(`  ${icon} ${label}${meta}\n`);
        if (info.isError) {
          const first = info.output.split("\n").slice(0, 4).join("\n  ");
          process.stdout.write(`${style.red(indent(first, "  "))}\n`);
        }
        if (this.runtime.config.verbose) {
          const body = info.output.split("\n").slice(0, 40).join("\n");
          process.stdout.write(`${style.dim(indent(body, "     "))}\n`);
        }
        this.spinner.start("thinking\u2026");
      },
      onAssistantText: (text) => {
        this.spinner.stop();
        if (text.trim().length === 0) return;
        process.stdout.write(`\n${renderMarkdown(text, { color: isColorEnabled(), prefix: "" })}\n\n`);
      },
      onTodos: (todos) => {
        this.todos = todos;
        this.renderTodos();
      },
      onCompact: (info) => {
        this.spinner.stop();
        process.stdout.write(
          `  ${style.yellow("\u21ba")} context compacted ${style.dim(`(~${info.estimatedTokens} \u2192 ~${info.after} tokens)`)}\n`,
        );
      },
      onSubagentStart: (info) => {
        this.spinner.stop();
        process.stdout.write(`  ${style.magenta("\u21b3")} ${style.bold(info.type)} ${style.dim(info.description)}\n`);
        this.spinner.start(`${info.type}\u2026`);
      },
      onSubagentEnd: (info) => {
        this.spinner.stop();
        process.stdout.write(
          `  ${style.magenta("\u21b3")} ${info.type} ${info.ok ? style.green("done") : style.red("failed")} ${style.dim(humanDuration(info.durationMs))}\n`,
        );
      },
      onLog: (level, message) => {
        if (level === "info" && !this.runtime.config.verbose) return;
        this.spinner.stop();
        const tag = level === "error" ? style.red("error") : level === "warn" ? style.yellow("warn") : style.dim("info");
        process.stdout.write(`  ${tag} ${message}\n`);
      },
      onUsage: (usage, cost) => {
        if (this.runtime.config.verbose) {
          process.stderr.write(
            `\r${style.dim(`tokens +${usage.inputTokens}/+${usage.outputTokens} \u00b7 $${cost.toFixed(4)}`)}\r`,
          );
        }
      },
    };
  }

  private renderTodos(): void {
    if (this.todos.length === 0) return;
    const lines = this.todos.map((todo) => {
      const mark = todo.status === "completed" ? style.green("\u2713") : todo.status === "in_progress" ? style.yellow("\u25b6") : style.dim("\u25a1");
      const body = todo.status === "pending" ? style.dim(todo.content) : todo.content;
      return `  ${mark} ${body}`;
    });
    process.stdout.write(`${style.dim("  tasks")}\n${lines.join("\n")}\n`);
  }

  private async runTurn(prompt: string): Promise<AgentResult | null> {
    if (this.running) {
      process.stdout.write(`${style.yellow("a turn is already running - Ctrl+C to interrupt")}\n`);
      return null;
    }
    this.running = true;
    this.controller = new AbortController();
    const startedAt = Date.now();

    // Re-create the agent when the session/model/agent changed externally.
    if (!this.agent || this.agent.signal !== this.controller.signal) {
      this.agent = await this.runtime.createAgent({ signal: this.controller.signal });
    }

    this.spinner.start("thinking\u2026");
    let result: AgentResult;
    try {
      result = await this.agent.run(prompt);
    } catch (error) {
      this.spinner.stop();
      const message = error instanceof Error ? error.message : String(error);
      process.stdout.write(`\n${style.red(`Error: ${message}`)}\n\n`);
      return null;
    } finally {
      this.spinner.stop();
      this.running = false;
    }

    if (this.runtime.session && this.runtime.session.messages.length <= 2) {
      await this.runtime.session.deriveTitle();
    }

    const footer = [
      `${result.turns} turn${result.turns === 1 ? "" : "s"}`,
      `${result.usage.inputTokens}in/${result.usage.outputTokens}out`,
      `$${result.costUsd.toFixed(4)}`,
      humanDuration(Date.now() - startedAt),
    ];
    if (result.stopReason === "error") {
      process.stdout.write(`${style.red("  run failed \u00b7 see messages above")}\n\n`);
    } else if (result.stopReason === "aborted") {
      process.stdout.write(`\n${style.yellow("  interrupted by user")}\n\n`);
    } else if (this.runtime.config.verbose || this.args.options.verbose === true) {
      process.stdout.write(`${style.dim(`  ${footer.join(" \u00b7 ")}`)}\n\n`);
    } else if (result.stopReason === "max_turns") {
      process.stdout.write(`\n${style.yellow("  stopped: max turns reached")}\n\n`);
    }
    return result;
  }

  private async runShell(command: string): Promise<void> {
    if (!command) {
      process.stdout.write(`${style.dim("usage: !<command>   e.g. !git status")}\n`);
      return;
    }
    const decision = await checkPermission(
      { tool: "Bash", input: { command }, target: command, source: "main" },
      {
        mode: this.runtime.config.permissionMode,
        allow: this.runtime.config.allowedTools,
        deny: this.runtime.config.disallowedTools,
        gate: this.runtime.gate,
        interactive: true,
        cwd: this.runtime.cwd,
      },
    );
    if (decision.action === "deny") {
      process.stdout.write(`${style.red(`  denied: ${decision.reason ?? "not allowed"}`)}\n`);
      if (!decision.reason?.includes("rule")) {
        process.stdout.write(`${style.dim(`  suggested rule: ${suggestAllowRule({ tool: "Bash", input: { command }, target: command })}`)}\n`);
      }
      return;
    }
    this.spinner.start(truncateEnd(command, 60));
    const result = await runCommand({ command, cwd: this.runtime.cwd });
    this.spinner.stop();
    process.stdout.write(`${renderText(result.output, { prefix: "  ", color: false })}\n`);
    process.stdout.write(`${style.dim(`  ${result.exitCode === 0 ? "ok" : `exit ${result.exitCode}`} \u00b7 ${humanDuration(result.durationMs)}`)}\n\n`);
  }

  /* ---------------------------------------------------------- slash cmds */

  private async handleSlash(line: string): Promise<"ok" | "exit"> {
    const [rawName, ...rest] = line.slice(1).split(/\s+/);
    const name = (rawName ?? "").toLowerCase();
    const args = rest.join(" ");
    const cfg = this.runtime.config;

    switch (name) {
      case "help":
      case "?": {
        if (args) {
          const detail = renderCommandHelp(args.split(/\s+/)[0]!);
          process.stdout.write(`${detail ?? `${style.yellow(`no help for "${args}"`)}`}\n\n`);
        } else {
          this.printSlashHelp();
        }
        return "ok";
      }
      case "exit":
      case "quit":
      case "q":
        return "exit";

      case "clear": {
        this.agent = await this.runtime.createAgent({ session: null });
        this.todos = [];
        process.stdout.write(`${style.dim("context cleared (session file kept - use /sessions to review)")}\n\n`);
        return "ok";
      }

      case "compact": {
        await this.compact(args);
        return "ok";
      }

      case "model": {
        if (!args) {
          process.stdout.write(`\ncurrent: ${style.cyan(this.runtime.model)}\navailable:\n`);
          for (const model of listModels()) {
            process.stdout.write(`  ${model.id.padEnd(28)} ${style.dim(`${model.provider} \u00b7 ${model.contextWindow} ctx`)}\n`);
          }
          process.stdout.write(`\n${style.dim("use /model <id> or --model <id>")}\n\n`);
          return "ok";
        }
        await this.switchModel(args.trim());
        return "ok";
      }

      case "agents": {
        process.stdout.write(`\n${style.bold("AI engineering team")}\n`);
        const entries = [...this.runtime.agents.values()].sort((a, b) => a.name.localeCompare(b.name));
        for (const entry of entries) {
          const marker = entry.name === this.agent.agentName ? style.green("\u25b8") : " ";
          const custom = entry.custom ? style.dim(" [custom]") : "";
          process.stdout.write(`  ${marker} ${entry.emoji ?? " "} ${style.cyan(entry.name.padEnd(20))} ${entry.description}${custom}\n`);
        }
        process.stdout.write(`\n${style.dim("switch: /agent <name> or @<name> <prompt>; add your own in .aet/agents/*.md\n")}`);
        return "ok";
      }

      case "agent": {
        if (!args) {
          await this.handleSlash("/agents");
          return "ok";
        }
        await this.switchAgent(args.trim().toLowerCase(), true);
        return "ok";
      }

      case "tools": {
        const tools = this.runtime.tools;
        process.stdout.write(`\n${style.bold(`Tools (${tools.length})`)}\n`);
        const width = Math.max(...tools.map((tool) => tool.spec.name.length));
        for (const tool of tools) {
          const first = tool.spec.description.split("\n")[0]!;
          process.stdout.write(`  ${tool.spec.name.padEnd(width)}  ${style.dim(truncateEnd(first, 90))}\n`);
        }
        const allowed = cfg.allowedTools;
        process.stdout.write(`\n${style.dim(`allow rules: ${allowed.join(", ") || "(none)"}\n`)}`);
        process.stdout.write(`${style.dim(`deny rules:  ${cfg.disallowedTools.join(", ") || "(none)"}\n\n`)}`);
        return "ok";
      }

      case "permissions":
      case "permission": {
        if (!args) {
          process.stdout.write(
            `\nmode: ${style.cyan(cfg.permissionMode)}\n` +
              `${style.dim("modes: default, acceptEdits, plan, bypassPermissions")}\n` +
              `${style.dim(`allow: ${cfg.allowedTools.join(", ")}`)}\n` +
              `${style.dim(`deny:  ${cfg.disallowedTools.join(", ") || "(none)"}\n\n`)}`,
          );
          return "ok";
        }
        const mode = args.trim() as PermissionMode;
        if (!PERMISSION_MODES.includes(mode)) {
          process.stdout.write(`${style.red(`unknown mode "${mode}" - expected ${PERMISSION_MODES.join(", ")}`)}\n\n`);
          return "ok";
        }
        cfg.permissionMode = mode;
        this.agent = await this.runtime.createAgent();
        process.stdout.write(`${style.green(`permission mode: ${mode}`)}\n\n`);
        return "ok";
      }

      case "config": {
        await this.configCommand(args);
        return "ok";
      }

      case "sessions": {
        const sessions = await Session.list(20);
        if (sessions.length === 0) {
          process.stdout.write(`${style.dim("no sessions yet")}\n\n`);
          return "ok";
        }
        process.stdout.write(`\n${style.bold("Recent sessions")}\n`);
        for (const session of sessions) {
          const current = session.id === this.runtime.session?.meta.id ? style.green("\u25b8") : " ";
          process.stdout.write(
            `  ${current} ${session.id}  ${style.dim(`${session.updatedAt.slice(0, 16).replace("T", " ")} \u00b7 ${session.messageCount ?? 0} msgs \u00b7 ${session.model}`)}\n` +
              `      ${truncateEnd(session.title, 80)}\n`,
          );
        }
        process.stdout.write(`\n${style.dim("resume: /resume <id>\n\n")}`);
        return "ok";
      }

      case "resume": {
        await this.resumeCommand(args);
        return "ok";
      }

      case "cost": {
        const tokens = this.agent.tokens;
        process.stdout.write(
          `\n${style.bold("Session usage")}\n` +
            `  requests  ${tokens.requests}\n` +
            `  input     ${tokens.inputTokens} tokens\n` +
            `  output    ${tokens.outputTokens} tokens\n` +
            `  cached    ${tokens.cacheReadTokens} tokens read / ${tokens.cacheWriteTokens} written\n` +
            `  estimated $${this.agent.costUsd.toFixed(4)}\n\n`,
        );
        return "ok";
      }

      case "context": {
        const system = await this.agent.ensureSystemPrompt();
        const estimate = this.agent.contextTokens();
        const pct = Math.round((estimate / cfg.contextWindow) * 100);
        process.stdout.write(
          `\n${style.bold("Context")}\n` +
            `  window    ${cfg.contextWindow} tokens\n` +
            `  system    ~${system.length} chars\n` +
            `  messages  ${this.agent.messages.length}\n` +
            `  estimated ~${estimate} tokens (${pct}%)\n` +
            `  auto-compact at ${Math.round(cfg.autoCompact * 100)}%\n\n`,
        );
        return "ok";
      }

      case "todos": {
        if (this.todos.length === 0) process.stdout.write(`${style.dim("no task list yet")}\n\n`);
        else this.renderTodos();
        return "ok";
      }

      case "mcp": {
        await this.mcpCommand(args);
        return "ok";
      }

      case "commands": {
        const custom = [...this.customCommands.values()];
        process.stdout.write(`\n${style.bold("Custom commands")}\n`);
        if (custom.length === 0) {
          process.stdout.write(`  ${style.dim("(none - add .aet/commands/*.md)")}\n`);
        }
        for (const command of custom) {
          process.stdout.write(`  ${style.cyan(`/${command.name}`)}  ${style.dim(command.description)}\n`);
        }
        process.stdout.write(`\n${style.dim(`files: ${[...this.customCommands.values()].map((c) => path.relative(this.runtime.cwd, c.source)).join(", ") || "-"}\n\n`)}`);
        return "ok";
      }

      case "verbose": {
        cfg.verbose = !cfg.verbose;
        process.stdout.write(`${style.dim(`verbose: ${cfg.verbose ? "on" : "off"}`)}\n\n`);
        return "ok";
      }

      case "debug": {
        cfg.debug = !cfg.debug;
        process.stdout.write(`${style.dim(`debug: ${cfg.debug ? "on" : "off"}`)}\n\n`);
        return "ok";
      }

      case "theme": {
        if (args === "mono") {
          cfg.theme = "mono";
          setColorEnabled(false);
        } else if (args === "default") {
          cfg.theme = "default";
          setColorEnabled(true);
        } else {
          process.stdout.write(`${style.dim(`theme: ${cfg.theme} (use /theme default|mono)`)}\n\n`);
          return "ok";
        }
        process.stdout.write(`${style.dim(`theme: ${cfg.theme}`)}\n\n`);
        return "ok";
      }

      case "team": {
        if (!args.trim()) {
          process.stdout.write(`${style.dim("usage: /team <goal> - run the plan/delegate/review pipeline")}\n\n`);
          return "ok";
        }
        await this.runTeamPipeline(args.trim());
        return "ok";
      }

      case "init": {
        process.stdout.write(`${style.dim("run `aet init` in your shell to scaffold .aet/ (or use /config set ... )")}\n\n`);
        return "ok";
      }

      case "export": {
        await this.exportSession(args);
        return "ok";
      }

      case "version": {
        process.stdout.write(`${renderVersion()}\n\n`);
        return "ok";
      }

      default: {
        const custom = this.customCommands.get(name);
        if (custom) {
          const prompt = await expandFileReferences(expandCommand(custom.body, args), this.runtime.cwd);
          const previousAgent = this.runtime.config.agent;
          const previousModel = this.runtime.model;
          if (custom.agent) this.runtime.config.agent = custom.agent;
          if (custom.model) await this.switchModel(custom.model, true);
          this.agent = await this.runtime.createAgent({ signal: this.controller?.signal });
          await this.runTurn(prompt);
          this.runtime.config.agent = previousAgent;
          if (custom.model) await this.switchModel(previousModel, true);
          this.agent = await this.runtime.createAgent();
          return "ok";
        }
        process.stdout.write(`${style.yellow(`unknown command: /${name}`)} ${style.dim("- try /help")}\n\n`);
        return "ok";
      }
    }
  }

  private printSlashHelp(): void {
    const groups: Array<[string, Array<[string, string]>]> = [
      [
        "session",
        [
          ["/clear", "forget the conversation (keeps the session file)"],
          ["/compact [note]", "summarise history to free context"],
          ["/resume [id]", "resume a saved session"],
          ["/sessions", "list saved sessions"],
          ["/export <file>", "write the transcript to a markdown file"],
          ["/exit", "quit (or Ctrl+D)"],
        ],
      ],
      [
        "team & model",
        [
          ["/team <goal>", "plan -> delegate -> review pipeline"],
          ["/agents", "list team roles"],
          ["/agent <name>", "switch the active role"],
          ["/model [id]", "show or switch model"],
          ["/tools", "list tools (incl. MCP)"],
          ["/todos", "show the task list"],
        ],
      ],
      [
        "config",
        [
          ["/permissions [mode]", "show or set permission mode"],
          ["/config [key] [value]", "read or write configuration"],
          ["/mcp [list|ping]", "manage MCP servers"],
          ["/commands", "list custom slash commands"],
          ["/verbose", "toggle verbose output"],
          ["/theme default|mono", "switch theme"],
          ["/cost", "session token/cost summary"],
          ["/context", "context window usage"],
        ],
      ],
    ];
    process.stdout.write(`\n${style.bold("Commands")}\n`);
    for (const [title, entries] of groups) {
      process.stdout.write(`\n  ${style.cyan(title)}\n`);
      for (const [command, description] of entries) {
        process.stdout.write(`    ${command.padEnd(22)} ${style.dim(description)}\n`);
      }
    }
    process.stdout.write(
      `\n  ${style.cyan("other")}\n` +
        `    ${"!command".padEnd(22)} ${style.dim("run a shell command directly")}\n` +
        `    ${"@file.ts".padEnd(22)} ${style.dim("inline a file into your prompt")}\n` +
        `    ${"@agent-name <task>".padEnd(22)} ${style.dim("run a prompt as a specific role")}\n` +
        `    ${"\\ at EOL or '.' alone".padEnd(22)} ${style.dim("multi-line input")}\n\n`,
    );
  }

  /* ------------------------------------------------------- command impls */

  private async switchAgent(name: string, announce: boolean): Promise<void> {
    const definition = getAgent(this.runtime.agents, name);
    if (!definition) {
      process.stdout.write(
        `${style.red(`unknown agent "${name}"`)} ${style.dim(`- try /agents (known: ${[...this.runtime.agents.keys()].join(", ")})`)}\n\n`,
      );
      return;
    }
    this.runtime.config.agent = definition.name;
    this.agent = await this.runtime.createAgent({ signal: this.controller?.signal });
    if (announce) {
      process.stdout.write(`${style.green(`agent: ${definition.name}`)} ${style.dim(`- ${definition.description}`)}\n\n`);
    }
  }

  private async switchModel(model: string, silent = false): Promise<void> {
    try {
      const { resolveProvider } = await import("../providers/index.js");
      const resolved = await resolveProvider({ model, debug: this.runtime.config.debug });
      this.runtime.provider = resolved.provider;
      this.runtime.providerId = resolved.providerId;
      this.runtime.model = resolved.model;
      this.runtime.config.model = resolved.model;
      this.agent = await this.runtime.createAgent({ signal: this.controller?.signal });
      if (!silent) {
        process.stdout.write(`${style.green(`model: ${resolved.model}`)} ${style.dim(`(${resolved.providerId})`)}\n\n`);
      }
    } catch (error) {
      process.stdout.write(`${style.red(`could not switch model: ${(error as Error).message}`)}\n\n`);
    }
  }

  private async compact(instruction: string): Promise<void> {
    this.spinner.start("compacting context\u2026");
    const system = await this.agent.ensureSystemPrompt();
    try {
      const result = await compactIfNeeded([...this.agent.messages, ...(instruction ? [{ role: "user" as const, content: [{ type: "text" as const, text: `[user asked to compact with note: ${instruction}]` }] }] : []), { role: "user" as const, content: [{ type: "text" as const, text: "The user asked for a manual compaction point. Summarise everything above this line." }] }], {
        provider: this.runtime.provider,
        model: this.runtime.model,
        system,
        config: this.runtime.config,
        force: true,
      });
      this.spinner.stop();
      this.agent.messages = result.messages;
      if (this.runtime.session) {
        for (const message of result.messages) await this.runtime.session.addMessage(message);
        if (result.summary) await this.runtime.session.summarize(result.summary);
      }
      process.stdout.write(
        `${style.green("\u2713 compacted")} ${style.dim(`~${this.agent.contextTokens()} tokens in context`)}\n` +
          (result.summary ? `${style.dim(truncateEnd(result.summary.replace(/\n/g, " "), 300))}\n` : "") +
          `\n`,
      );
    } catch (error) {
      this.spinner.stop();
      process.stdout.write(`${style.red(`compaction failed: ${(error as Error).message}`)}\n\n`);
    }
  }

  private async configCommand(args: string): Promise<void> {
    const [action, key, ...valueParts] = args.split(/\s+/);
    const cfg = this.runtime.config;

    if (!action) {
      process.stdout.write(`\n${style.bold("Configuration")}\n`);
      const entries = Object.entries(cfg) as Array<[string, unknown]>;
      for (const [entryKey, value] of entries) {
        const rendered = Array.isArray(value)
          ? `[${value.join(", ")}]`
          : typeof value === "object" && value !== null
            ? `${Object.keys(value as object).length} entries`
            : String(value);
        process.stdout.write(`  ${entryKey.padEnd(18)} ${style.dim(truncateEnd(rendered, 70))}\n`);
      }
      process.stdout.write(`\n${style.dim(`file: ~/.aet/config.json (user) + .aet/config.json (project)\n\n`)}`);
      return;
    }

    if (action === "get") {
      if (!key) {
        process.stdout.write(`${style.dim("usage: /config get <key>")}\n\n`);
        return;
      }
      const value = (cfg as unknown as Record<string, unknown>)[key];
      process.stdout.write(`${style.cyan(key)} = ${style.bold(Array.isArray(value) ? value.join(",") : String(value))}\n\n`);
      return;
    }

    if (action === "set") {
      const rawValue = valueParts.join(" ");
      if (!key || !rawValue) {
        process.stdout.write(`${style.dim("usage: /config set <key> <value>")}\n\n`);
        return;
      }
      const { parseScalar } = await import("../core/config.js");
      const parsed = parseScalar(rawValue);
      await saveUserConfig({ [key]: parsed });
      (cfg as unknown as Record<string, unknown>)[key] = parsed;
      process.stdout.write(`${style.green(`saved ${key} = ${rawValue}`)} ${style.dim("(~/.aet/config.json)")}\n\n`);
      return;
    }

    process.stdout.write(`${style.dim("usage: /config [get <key>|set <key> <value>]")}\n\n`);
  }

  private async resumeCommand(args: string): Promise<void> {
    let id = args.trim();
    if (!id) {
      const sessions = await Session.list(20);
      if (sessions.length === 0) {
        process.stdout.write(`${style.dim("no sessions to resume")}\n\n`);
        return;
      }
      const picked = await choose(
        this.rl,
        "Resume a session",
        sessions.map((session) => ({
          label: `${session.title}`,
          value: session.id,
          hint: `${session.id} \u00b7 ${session.updatedAt.slice(0, 16).replace("T", " ")}`,
        })),
      );
      if (!picked) return;
      id = picked;
    }
    const session = await Session.load(id);
    if (!session) {
      process.stdout.write(`${style.red(`session "${id}" not found`)}\n\n`);
      return;
    }
    this.runtime.session = session;
    this.agent = await this.runtime.createAgent({ signal: this.controller?.signal });
    process.stdout.write(
      `${style.green(`resumed ${session.meta.id}`)} ${style.dim(`${session.messages.length} messages \u00b7 ${session.meta.title}`)}\n\n`,
    );
  }

  private async mcpCommand(args: string): Promise<void> {
    const [action, ...rest] = args.split(/\s+/);
    const servers = await loadMcpServers(this.runtime.cwd);

    if (!action || action === "list") {
      const names = Object.keys(servers);
      process.stdout.write(`\n${style.bold("MCP servers")}\n`);
      if (names.length === 0) {
        process.stdout.write(`  ${style.dim("(none configured - aet mcp add <name> <command...>)")}\n`);
      }
      for (const name of names) {
        const server = servers[name]!;
        const transport = server.url ? `http ${server.url}` : `${server.command} ${(server.args ?? []).join(" ")}`;
        process.stdout.write(`  ${style.cyan(name.padEnd(18))} ${style.dim(truncateEnd(transport, 80))}\n`);
      }
      const mcpTools = this.runtime.tools.filter((tool) => tool.spec.name.startsWith("mcp__"));
      process.stdout.write(`\n${style.dim(`${mcpTools.length} MCP tool(s) loaded in this session\n`)}`);
      if (mcpTools.length > 0) {
        for (const tool of mcpTools) process.stdout.write(`    ${tool.spec.name}\n`);
      }
      process.stdout.write(`\n`);
      return;
    }

    if (action === "ping") {
      const names = rest[0] ? [rest[0]] : Object.keys(servers);
      if (names.length === 0) {
        process.stdout.write(`${style.dim("no servers to ping")}\n\n`);
        return;
      }
      for (const name of names) {
        const server = servers[name];
        if (!server) {
          process.stdout.write(`${style.red(`  ${name}: not configured`)}\n`);
          continue;
        }
        const result = await pingServer(name, server);
        process.stdout.write(
          result.ok
            ? `  ${style.green("\u2713")} ${name} ${style.dim(`${result.latencyMs}ms \u00b7 ${result.tools} tools`)}\n`
            : `  ${style.red("\u2717")} ${name} ${style.dim(result.error ?? "failed")}\n`,
        );
      }
      process.stdout.write(`\n`);
      return;
    }

    if (action === "add" || action === "remove") {
      process.stdout.write(
        `${style.dim(`use the shell CLI: aet mcp ${action === "add" ? "add <name> <command...>" : "remove <name>"}`)}\n` +
          `${style.dim(`file: ${path.relative(process.cwd(), mcpFileFor(this.runtime.cwd, "project"))}`)}\n\n`,
      );
      return;
    }
    process.stdout.write(`${style.dim("usage: /mcp [list|ping [name]]")}\n\n`);
  }

  private async exportSession(args: string): Promise<void> {
    const target = path.resolve(this.runtime.cwd, args.trim() || `aet-session-${Date.now()}.md`);
    const session = this.runtime.session;
    if (!session) {
      process.stdout.write(`${style.dim("no active session")}\n\n`);
      return;
    }
    const lines = [
      `# Session ${session.meta.id}`,
      ``,
      `- created: ${session.meta.createdAt}`,
      `- model: ${session.meta.model}`,
      `- agent: ${session.meta.agent}`,
      ``,
      `---`,
      ``,
    ];
    for (const message of session.messages) {
      const body = message.content
        .map((block) => {
          if (block.type === "text") return block.text;
          if (block.type === "tool_use") return `**${block.name}** \`${JSON.stringify(block.input).slice(0, 300)}\``;
          return `_tool result:_\n\`\`\`\n${block.content.slice(0, 1000)}\n\`\`\``;
        })
        .join("\n\n");
      lines.push(`## ${message.role}`, "", body, "");
    }
    await fs.writeFile(target, `${lines.join("\n")}\n`, "utf8");
    process.stdout.write(`${style.green(`exported to ${target}`)}\n\n`);
  }

  private async runTeamPipeline(goal: string): Promise<void> {
    this.spinner.start("tech-lead planning\u2026");
    const controller = new AbortController();
    try {
      const report = await runTeam({
        goal,
        cwd: this.runtime.cwd,
        config: this.runtime.config,
        provider: this.runtime.provider,
        providerId: this.runtime.providerId,
        model: this.runtime.model,
        agents: this.runtime.agents,
        tools: this.runtime.tools,
        interactive: true,
        ...(this.runtime.gate ? { gate: this.runtime.gate } : {}),
        signal: controller.signal,
        events: {
          onLog: (level, message) => {
            this.spinner.stop();
            const tag = level === "error" ? style.red(" \u2717") : level === "warn" ? style.yellow(" !") : style.magenta(" \u2192");
            process.stdout.write(`  ${tag} ${message}\n`);
            this.spinner.start("working\u2026");
          },
        },
      });
      this.spinner.stop();
      process.stdout.write(`\n${renderMarkdown(formatTeamReport(report), { color: isColorEnabled() })}\n\n`);
      process.stdout.write(`${style.dim(`  ${report.tasks.length} tasks \u00b7 $${report.costUsd.toFixed(4)} \u00b7 ${humanDuration(report.durationMs)}`)}\n\n`);
    } catch (error) {
      this.spinner.stop();
      process.stdout.write(`${style.red(`team run failed: ${(error as Error).message}`)}\n\n`);
    }
  }
}

function indent(text: string, prefix: string): string {
  return text
    .split("\n")
    .map((line) => `${prefix}${line}`)
    .join("\n");
}

function optionBoolQuiet(args: ParsedArgs): boolean {
  return args.options.quiet === true;
}
