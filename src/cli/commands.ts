/** Non-interactive subcommands: agents, tools, config, sessions, doctor, mcp, init, team, auth, completions. */

import * as path from "node:path";
import * as fs from "node:fs/promises";
import * as readline from "node:readline";
import { Writable } from "node:stream";
import { style, setColorEnabled } from "../util/color.js";
import { ensureDir, pathExists, readTextFile, writeTextFileAtomic } from "../util/fsx.js";
import { humanDuration, truncateEnd, splitList } from "../util/text.js";
import { getPaths, projectPaths } from "../core/paths.js";
import {
  DEFAULT_CONFIG,
  getConfigValue,
  loadConfig,
  parseScalar,
  saveUserConfig,
} from "../core/config.js";
import { Session } from "../core/session.js";
import { resolveAgents, BUILTIN_AGENTS } from "../team/agents.js";
import { builtinTools } from "../tools/index.js";
import { listModels } from "../providers/models.js";
import { resolveProvider, MissingCredentialError } from "../providers/index.js";
import { getCredential, setCredential, clearCredential, baseUrlFor, type AuthProvider } from "../core/auth.js";
import { loadMcpServers, saveMcpServer, removeMcpServer, mcpFileFor, type McpScope } from "../mcp/config.js";
import { pingServer, McpRegistry } from "../mcp/client.js";
import { runTeam, formatTeamReport } from "../team/orchestrator.js";
import { Runtime } from "./runtime.js";
import type { ParsedArgs } from "./args.js";
import { optionString, optionBool, optionNumber } from "./args.js";
import { renderCommandHelp, renderVersion, GLOBAL_OPTIONS, COMMANDS } from "./help.js";
import { VERSION, CREDIT, REPO_URL, AUTHOR, AUTHOR_URL, ORGANIZATION } from "../version.js";

const AUTH_PROVIDERS: AuthProvider[] = ["anthropic", "openai", "openrouter", "groq", "deepseek"];

export async function runSubcommand(name: string, argv: string[], args: ParsedArgs, cwd: string): Promise<number> {
  switch (name) {
    case "agents":
      return agentsCommand(cwd);
    case "tools":
      return toolsCommand(cwd, args);
    case "config":
      return configCommand(argv, cwd);
    case "sessions":
      return sessionsCommand(argv, args);
    case "doctor":
      return doctorCommand(args, cwd);
    case "mcp":
      return mcpCommand(argv, args, cwd);
    case "init":
      return initCommand(argv, args, cwd);
    case "team":
      return teamCommand(argv, args, cwd);
    case "auth":
      return authCommand(argv);
    case "completions":
      return completionsCommand(argv);
    case "help":
      return helpCommand(argv);
    case "version":
      process.stdout.write(`${renderVersion()}\n`);
      return 0;
    default:
      process.stderr.write(`${style.red(`unknown command: ${name}`)}\n`);
      return 2;
  }
}

function out(line = ""): void {
  process.stdout.write(`${line}\n`);
}

/* ------------------------------------------------------------------ agents */

async function agentsCommand(cwd: string): Promise<number> {
  const agents = await resolveAgents(cwd);
  const entries = [...agents.values()].sort((a, b) => Number(Boolean(a.custom)) - Number(Boolean(b.custom)) || a.name.localeCompare(b.name));

  out();
  out(`${style.bold("AI Engineering Team")} ${style.dim(`(${entries.length} roles)`)}`);
  out();
  const width = Math.max(...entries.map((entry) => entry.name.length));
  for (const entry of entries) {
    const source = entry.custom ? style.cyan("custom") : style.dim("built-in");
    const tools = entry.tools ? style.yellow(` tools: ${entry.tools.join(",")}`) : "";
    out(`  ${entry.emoji ?? " "} ${style.cyan(entry.name.padEnd(width))}  ${entry.description} ${source}${tools}`);
    if (entry.model || entry.permissionMode) {
      out(`     ${style.dim(`${entry.model ?? "-"} \u00b7 ${entry.permissionMode ?? "inherit"}`)}`);
    }
  }
  out();
  out(style.dim(`Use: aet --agent <role>  |  in REPL: /agent <role>  |  @${entries[0]?.name ?? "general"} <prompt>`));
  out(style.dim(`Add your own: .aet/agents/*.md or ${getPaths().globalAgentsDir}`));
  out();
  return 0;
}

/* ------------------------------------------------------------------- tools */

async function toolsCommand(cwd: string, args: ParsedArgs): Promise<number> {
  const tools = builtinTools();
  out();
  out(`${style.bold(`Tools (${tools.length})`)} ${style.dim("- available to every agent")}`);
  out();
  const width = Math.max(...tools.map((tool) => tool.spec.name.length));
  for (const tool of tools) {
    const first = tool.spec.description.split("\n")[0] ?? "";
    out(`  ${style.cyan(tool.spec.name.padEnd(width))}  ${truncateEnd(first, 96)}`);
  }

  const servers = await loadMcpServers(cwd);
  const names = Object.keys(servers);
  out();
  if (names.length === 0) {
    out(style.dim("MCP: no servers configured (aet mcp add <name> <command...>)"));
    out();
    return 0;
  }

  out(`${style.bold(`MCP servers (${names.length})`)} ${style.dim("- tools appear as mcp__<server>__<tool>")}`);
  for (const name of names) {
    const server = servers[name]!;
    out(`  ${style.cyan(name.padEnd(18))} ${style.dim(server.url ?? `${server.command} ${(server.args ?? []).join(" ")}`)}`);
  }

  // Connect to list the actual tools (bounded so a broken server can't hang).
  if (optionBool(args, "no-mcp")) {
    out();
    out(style.dim("(tool listing skipped - start a session or run `aet mcp ping`)"));
    out();
    return 0;
  }
  const registry = new McpRegistry(servers);
  try {
    const started = await registry.start();
    for (const status of started.status) {
      if (status.status !== "ready") {
        out(`  ${style.yellow("!")} ${status.name}: ${status.status}${status.error ? ` - ${truncateEnd(status.error, 80)}` : ""}`);
      }
    }
    if (started.tools.length > 0) {
      out();
      out(style.bold(`MCP tools (${started.tools.length})`));
      const toolWidth = Math.max(...started.tools.map((tool) => tool.spec.name.length));
      for (const tool of started.tools) {
        const first = tool.spec.description.split("\n")[0] ?? "";
        out(`  ${style.cyan(tool.spec.name.padEnd(toolWidth))}  ${truncateEnd(first, 90)}`);
      }
    }
  } catch (error) {
    out(`  ${style.yellow("!")} MCP startup failed: ${truncateEnd((error as Error).message, 100)}`);
  } finally {
    await registry.stop().catch(() => undefined);
  }
  out();
  return 0;
}

/* ------------------------------------------------------------------ config */

async function configCommand(argv: string[], cwd: string): Promise<number> {
  const [action, key, ...rest] = argv;
  const config = await loadConfig({ cwd });

  if (!action || action === "list") {
    out();
    out(`${style.bold("Configuration")} ${style.dim("(defaults < ~/.aet/config.json < .aet/config.json < env < flags)")}`);
    out();
    for (const [entryKey, value] of Object.entries(config)) {
      const rendered = Array.isArray(value)
        ? `[${value.join(", ")}]`
        : value !== null && typeof value === "object"
          ? JSON.stringify(value)
          : String(value);
      out(`  ${entryKey.padEnd(18)} ${style.dim(truncateEnd(rendered, 90))}`);
    }
    out();
    return 0;
  }

  if (action === "get") {
    if (!key) {
      process.stderr.write("usage: aet config get <key>\n");
      return 2;
    }
    const value = getConfigValue(config, key);
    out(value === undefined ? "" : Array.isArray(value) ? value.join(",") : typeof value === "object" ? JSON.stringify(value) : String(value));
    return 0;
  }

  if (action === "set") {
    const value = rest.join(" ");
    if (!key || value.length === 0) {
      process.stderr.write("usage: aet config set <key> <value>\n");
      return 2;
    }
    const parsed = parseScalar(value);
    await saveUserConfig({ [key]: parsed });
    out(`${style.green("saved")} ${key} = ${value} ${style.dim("\u2192 ~/.aet/config.json")}`);
    return 0;
  }

  if (action === "reset") {
    await saveUserConfig(DEFAULT_CONFIG as unknown as Record<string, unknown>);
    out(`${style.green("reset")} user configuration to defaults`);
    return 0;
  }

  process.stderr.write("usage: aet config [list|get <key>|set <key> <value>|reset]\n");
  return 2;
}

/* ---------------------------------------------------------------- sessions */

async function sessionsCommand(argv: string[], args: ParsedArgs): Promise<number> {
  const [action, id] = argv;
  setColorEnabled(args.options["no-color"] !== true);

  if (!action || action === "list") {
    const sessions = await Session.list(50);
    if (sessions.length === 0) {
      out(style.dim("no sessions yet - start one with `aet`"));
      return 0;
    }
    out();
    out(`${style.bold("Sessions")} ${style.dim(`(${getPaths().sessionsDir})`)}`);
    out();
    for (const session of sessions) {
      out(`  ${style.cyan(session.id)}  ${style.dim(`${session.updatedAt.slice(0, 16).replace("T", " ")} \u00b7 ${String(session.messageCount ?? 0).padStart(3)} msgs \u00b7 ${session.model}`)}`);
      out(`      ${truncateEnd(session.title, 90)}`);
      out(`      ${style.dim(session.cwd)}`);
    }
    out();
    out(style.dim("resume: aet --resume <id>   |   aet sessions resume <id>"));
    return 0;
  }

  if (action === "resume") {
    // `aet sessions resume <id>` is rewritten into `aet --resume <id>` by the
    // entry point before dispatch, so reaching here means the id was missing.
    process.stderr.write("usage: aet sessions resume <id>   (or: aet --resume <id>)\n");
    return 2;
  }

  if (action === "delete") {
    if (!id) {
      process.stderr.write("usage: aet sessions delete <id>\n");
      return 2;
    }
    const removed = await Session.remove(id);
    out(removed ? `${style.green("deleted")} ${id}` : `${style.red(`session "${id}" not found`)}`);
    return removed ? 0 : 1;
  }

  process.stderr.write("usage: aet sessions [list|resume <id>|delete <id>]\n");
  return 2;
}

/* ------------------------------------------------------------------ doctor */

interface Check {
  label: string;
  ok: boolean;
  detail: string;
  critical?: boolean;
}

async function doctorCommand(args: ParsedArgs, cwd: string): Promise<number> {
  const checks: Check[] = [];
  const startedAt = Date.now();

  // Node ---------------------------------------------------------------
  const [major, minor] = process.versions.node.split(".").map(Number);
  checks.push({
    label: "Node.js runtime",
    ok: major! >= 20,
    detail: `v${process.versions.node} (requires >= 20.10)`,
    critical: true,
  });
  void minor;

  // Home dir ------------------------------------------------------------
  try {
    const home = getPaths().home;
    await ensureDir(home);
    const probe = path.join(home, `.doctor-${Date.now()}`);
    await fs.writeFile(probe, "ok");
    await fs.unlink(probe);
    checks.push({ label: "AET home writable", ok: true, detail: home });
  } catch (error) {
    checks.push({ label: "AET home writable", ok: false, detail: (error as Error).message, critical: true });
  }

  // Config ---------------------------------------------------------------
  try {
    const config = await loadConfig({ cwd });
    checks.push({
      label: "Configuration",
      ok: true,
      detail: `model=${config.model} agent=${config.agent} mode=${config.permissionMode}`,
    });

    // Credentials ---------------------------------------------------------
    const found: string[] = [];
    for (const provider of AUTH_PROVIDERS) {
      const credential = await getCredential(provider);
      if (credential.apiKey) found.push(`${provider} (${credential.source})`);
    }
    checks.push({
      label: "API credentials",
      ok: found.length > 0 || config.provider === "mock",
      detail: found.length > 0 ? found.join(", ") : "none found - set ANTHROPIC_API_KEY / OPENAI_API_KEY or run `aet auth login <provider>`",
      critical: config.provider !== "mock",
    });

    // Provider resolution -------------------------------------------------
    try {
      const resolved = await resolveProvider({ model: config.model, ...(config.provider ? { provider: config.provider } : {}) });
      checks.push({ label: "Provider resolution", ok: true, detail: `${resolved.providerId} / ${resolved.model}` });
      if (resolved.providerId !== "mock") {
        const reachable = await probeUrl(baseUrlFor(resolved.providerId as AuthProvider) ?? "https://api.anthropic.com");
        checks.push({
          label: "Provider reachability",
          ok: reachable.ok,
          detail: reachable.ok ? `${reachable.status} in ${reachable.ms}ms` : (reachable.error ?? "unreachable"),
        });
      }
    } catch (error) {
      checks.push({
        label: "Provider resolution",
        ok: false,
        detail: (error as Error).message,
        critical: !(error instanceof MissingCredentialError),
      });
    }

    // MCP -----------------------------------------------------------------
    const servers = await loadMcpServers(cwd);
    const names = Object.keys(servers);
    if (names.length === 0) {
      checks.push({ label: "MCP servers", ok: true, detail: "none configured" });
    } else {
      for (const name of names) {
        const result = await pingServer(name, servers[name]!);
        checks.push({
          label: `MCP ${name}`,
          ok: result.ok,
          detail: result.ok ? `${result.latencyMs}ms \u00b7 ${result.tools} tools` : (result.error ?? "failed"),
        });
      }
    }

    // Backend -------------------------------------------------------------
    if (config.backendUrl) {
      const health = await probeUrl(`${config.backendUrl.replace(/\/$/, "")}/health`);
      checks.push({
        label: "Backend health",
        ok: health.ok && (health.status ?? 0) < 400,
        detail: health.ok ? `${health.status} in ${health.ms}ms` : (health.error ?? "unreachable"),
      });
    }

    // Workspace -----------------------------------------------------------
    const gitDir = path.join(cwd, ".git");
    checks.push({
      label: "Workspace",
      ok: true,
      detail: `${cwd}${(await pathExists(gitDir)) ? " (git repo)" : ""}`,
    });
    const instructionFiles: string[] = [];
    for (const file of projectPaths(cwd).instructions) {
      if (await pathExists(file)) instructionFiles.push(path.basename(file));
    }
    checks.push({
      label: "Instruction files",
      ok: true,
      detail: instructionFiles.length > 0 ? instructionFiles.join(", ") : "none (add AET.md or AGENTS.md)",
    });
  } catch (error) {
    checks.push({ label: "Configuration", ok: false, detail: (error as Error).message, critical: true });
  }

  // Report ---------------------------------------------------------------
  out();
  out(`${style.bold("aet doctor")} ${style.dim(`v${VERSION}`)}`);
  out();
  let failures = 0;
  for (const check of checks) {
    const mark = check.ok ? style.green("\u2713") : check.critical ? style.red("\u2717") : style.yellow("!");
    if (!check.ok) failures += 1;
    out(`  ${mark} ${check.label.padEnd(24)} ${style.dim(check.detail)}`);
  }
  out();
  out(style.dim(`checked in ${humanDuration(Date.now() - startedAt)} \u00b7 ${failures} issue(s)`));
  out();
  return checks.some((check) => !check.ok && check.critical) ? 1 : 0;
}

async function probeUrl(url: string): Promise<{ ok: boolean; status?: number; ms: number; error?: string }> {
  const startedAt = Date.now();
  try {
    const response = await fetch(url, { method: "GET", signal: AbortSignal.timeout(6000) });
    return { ok: response.status < 500, status: response.status, ms: Date.now() - startedAt };
  } catch (error) {
    return { ok: false, ms: Date.now() - startedAt, error: (error as Error).message };
  }
}

/* --------------------------------------------------------------------- mcp */

async function mcpCommand(argv: string[], args: ParsedArgs, cwd: string): Promise<number> {
  const [action, ...rest] = argv;
  const scope: McpScope = optionBool(args, "global") ? "global" : "project";

  if (!action || action === "list") {
    const servers = await loadMcpServers(cwd);
    const names = Object.keys(servers);
    out();
    if (names.length === 0) {
      out(style.dim("no MCP servers configured"));
      out(style.dim("  aet mcp add filesystem -- npx -y @modelcontextprotocol/server-filesystem ./"));
      out(style.dim("  aet mcp add github --env GITHUB_TOKEN=... -- gh mcp"));
      out();
      return 0;
    }
    out(`${style.bold("MCP servers")} ${style.dim(`(${names.length})`)}`);
    out();
    for (const name of names) {
      const server = servers[name]!;
      const spec = server.url ? `http ${server.url}` : `${server.command} ${(server.args ?? []).join(" ")}`;
      const env = Object.keys(server.env ?? {});
      out(`  ${style.cyan(name)}  ${server.enabled === false ? style.yellow("[disabled]") : ""}`);
      out(`    ${style.dim(truncateEnd(spec, 100))}`);
      if (env.length > 0) out(`    ${style.dim(`env: ${env.join(", ")}`)}`);
    }
    out();
    out(style.dim(`config: ${path.relative(cwd, mcpFileFor(cwd, "project"))} \u00b7 aet mcp ping to test`));
    out();
    return 0;
  }

  if (action === "add") {
    const name = rest.shift();
    if (!name) {
      process.stderr.write("usage: aet mcp add <name> [--global] [--url <url>] [--env K=V,K2=V2] -- <command> [args...]\n");
      return 2;
    }
    const url = optionString(args, "url");
    const env: Record<string, string> = {};
    for (const pair of splitList(optionString(args, "env"))) {
      const eq = pair.indexOf("=");
      if (eq > 0) env[pair.slice(0, eq)] = pair.slice(eq + 1);
    }
    // Command parts: everything after `--`, otherwise the remaining positionals.
    const commandParts = (args.passthrough.length > 0 ? args.passthrough : rest).filter((token) => token !== "--");

    if (!url && commandParts.length === 0) {
      process.stderr.write("aet mcp add: provide a command (stdio) or --url (http)\n");
      return 2;
    }

    const server = url
      ? { url, enabled: true, ...(Object.keys(env).length > 0 ? { headers: env } : {}) }
      : { command: commandParts[0]!, args: commandParts.slice(1), enabled: true, ...(Object.keys(env).length > 0 ? { env } : {}) };

    const file = await saveMcpServer(cwd, scope, name, server);
    out(`${style.green("added")} ${name} ${style.dim(`\u2192 ${file}`)}`);
    out(style.dim(`verify with: aet mcp ping ${name}`));
    return 0;
  }

  if (action === "remove" || action === "rm") {
    const name = rest[0];
    if (!name) {
      process.stderr.write("usage: aet mcp remove <name>\n");
      return 2;
    }
    const file = await removeMcpServer(cwd, name);
    if (!file) {
      process.stderr.write(`${style.red(`server "${name}" not found`)}`);
      return 1;
    }
    out(`${style.green("removed")} ${name} ${style.dim(`from ${file}`)}`);
    return 0;
  }

  if (action === "ping") {
    const servers = await loadMcpServers(cwd);
    const names = rest.length > 0 ? rest : Object.keys(servers);
    if (names.length === 0) {
      out(style.dim("no servers to ping"));
      return 0;
    }
    let failures = 0;
    for (const name of names) {
      const server = servers[name];
      if (!server) {
        out(`  ${style.red("\u2717")} ${name} ${style.dim("not configured")}`);
        failures += 1;
        continue;
      }
      const result = await pingServer(name, server);
      if (result.ok) {
        out(`  ${style.green("\u2713")} ${name.padEnd(18)} ${style.dim(`${result.latencyMs}ms \u00b7 ${result.tools} tools`)}`);
      } else {
        failures += 1;
        out(`  ${style.red("\u2717")} ${name.padEnd(18)} ${style.dim(result.error ?? "failed")}`);
      }
    }
    return failures > 0 ? 1 : 0;
  }

  process.stderr.write("usage: aet mcp [list|add|remove|ping]\n");
  return 2;
}

/* -------------------------------------------------------------------- init */

async function initCommand(argv: string[], args: ParsedArgs, cwd: string): Promise<number> {
  const force = optionBool(args, "force");
  const dir = projectPaths(cwd).dir;
  const created: string[] = [];

  const writeIfMissing = async (target: string, contents: string): Promise<void> => {
    if ((await pathExists(target)) && !force) return;
    await writeTextFileAtomic(target, contents);
    created.push(path.relative(cwd, target));
  };

  await ensureDir(dir);
  await ensureDir(projectPaths(cwd).agentsDir);
  await ensureDir(projectPaths(cwd).commandsDir);

  await writeIfMissing(
    projectPaths(cwd).config,
    `${JSON.stringify(
      {
        $comment: `AI Engineering Team project config - see ${REPO_URL}/blob/main/docs/configuration.md`,
        model: DEFAULT_CONFIG.model,
        agent: "general",
        permissionMode: "default",
        allowedTools: DEFAULT_CONFIG.allowedTools,
        disallowedTools: [],
        maxTurns: DEFAULT_CONFIG.maxTurns,
      },
      null,
      2,
    )}\n`,
  );

  await writeIfMissing(
    path.join(cwd, "AET.md"),
    `# Project instructions for AI Engineering Team

These instructions are loaded into every session started in this directory.

## What this project is

<!-- One paragraph: purpose, users, the problem it solves. -->

## Commands

<!-- How to install, run, test, lint, build. Keep them copy-pasteable. -->

- Install: \`npm install\`
- Dev: \`npm run dev\`
- Test: \`npm test\`

## Architecture

<!-- Key directories, data flow, where things live. -->

## Conventions

- Follow the existing style of the file you are editing.
- Never commit secrets; use environment variables.
- Add tests for behaviour changes.

## Out of scope

<!-- What the agent should not touch (generated code, vendor dirs, ...). -->
`,
  );

  await writeIfMissing(
    path.join(projectPaths(cwd).agentsDir, "backend-expert.md"),
    `---
name: backend-expert
description: Domain-specific backend role for this repository
tools: Read, Glob, Grep, LS, Bash, Edit, Write, MultiEdit, TodoWrite
model: 
permissionMode: acceptEdits
---
You are the backend specialist for THIS repository.

- Learn the framework and patterns already in use before writing code.
- Validate inputs, handle errors explicitly, and keep handlers thin.
- Update tests alongside implementation changes.
`,
  );

  await writeIfMissing(
    path.join(projectPaths(cwd).commandsDir, "review.md"),
    `---
name: review
description: Review the current diff like a strict staff engineer
allowed-tools: Read, Glob, Grep, Bash
---
Review the uncommitted changes in this repository ($ARGUMENTS).

1. Run \`git status --porcelain\` and \`git diff\` to see what changed.
2. Read the changed files with context around each hunk.
3. Report: summary, blockers (file:line + why + fix), suggestions, verdict.
`,
  );

  const gitignore = path.join(cwd, ".gitignore");
  const gitignoreContents = await readTextFile(gitignore);
  if (gitignoreContents !== null && !gitignoreContents.includes(".aet/sessions")) {
    await fs.appendFile(gitignore, `\n# AI Engineering Team local state\n.aet/sessions/\n.aet/cache/\n`, "utf8");
    created.push(".gitignore (updated)");
  }

  out();
  if (created.length === 0) {
    out(style.dim("already initialised - use --force to overwrite"));
  } else {
    out(`${style.green("created")} .aet/ scaffolding:`);
    for (const file of created) out(`  ${style.cyan(file)}`);
    out();
    out(style.dim("next: edit AET.md with your project instructions, then run `aet`"));
  }
  out();
  return 0;
}

/* -------------------------------------------------------------------- team */

async function teamCommand(argv: string[], args: ParsedArgs, cwd: string): Promise<number> {
  const goal = argv.filter((token) => !token.startsWith("--")).join(" ").trim();
  if (!goal) {
    process.stderr.write('usage: aet team "<goal>" [--plan-only] [--max-parallel 3]\n');
    return 2;
  }

  const planOnly = optionBool(args, "plan-only");
  const maxParallel = optionNumber(args, "max-parallel") ?? 3;

  const interactive = Boolean(process.stdin.isTTY) && args.options["dangerously-skip-permissions"] !== true;
  const controller = new AbortController();
  const onSigint = (): void => controller.abort();
  process.once("SIGINT", onSigint);

  let runtime: Runtime | undefined;
  try {
    runtime = await Runtime.create({ cwd, args, interactive });
    const report = await runTeam({
      goal,
      cwd,
      config: runtime.config,
      provider: runtime.provider,
      providerId: runtime.providerId,
      model: runtime.model,
      agents: runtime.agents,
      tools: runtime.tools,
      interactive,
      ...(runtime.gate ? { gate: runtime.gate } : {}),
      signal: controller.signal,
      maxParallel,
      planOnly,
      events: {
        onLog: (level, message) => {
          const tag = level === "error" ? style.red(" \u2717") : level === "warn" ? style.yellow(" !") : style.magenta(" \u2192");
          process.stderr.write(`${tag} ${message}\n`);
        },
      },
    });

    out();
    out(formatTeamReport(report));
    out();
    if (report.plan.tasks.length > 0) {
      out(style.dim(`plan: ${report.plan.tasks.length} tasks \u00b7 roles: ${[...new Set(report.plan.tasks.map((t) => t.role))].join(", ")}`));
    }
    out(style.dim(`cost: $${report.costUsd.toFixed(4)} \u00b7 ${humanDuration(report.durationMs)}\u00b7 session ${runtime.session?.meta.id ?? "-"}`));
    out();
    return report.stopReason === "error" ? 1 : 0;
  } catch (error) {
    process.stderr.write(`${style.red(`team failed: ${(error as Error).message}`)}\n`);
    return 1;
  } finally {
    process.removeListener("SIGINT", onSigint);
    await runtime?.close();
  }
}

/* -------------------------------------------------------------------- auth */

async function authCommand(argv: string[]): Promise<number> {
  const [action, providerRaw] = argv;
  const provider = (providerRaw ?? "") as AuthProvider;

  if (!action || action === "status") {
    out();
    out(`${style.bold("Credentials")} ${style.dim("(env wins over ~/.aet/auth.json)")}`);
    out();
    for (const name of AUTH_PROVIDERS) {
      const credential = await getCredential(name);
      const mark = credential.apiKey ? style.green("\u2713") : style.dim("\u25cb");
      const mask = credential.apiKey ? `${credential.apiKey.slice(0, 6)}${"\u2022".repeat(6)}` : "-";
      out(`  ${mark} ${name.padEnd(12)} ${credential.apiKey ? `${style.dim(credential.source)} ${mask}` : style.dim("not configured")}`);
    }
    out();
    out(style.dim("aet auth login <provider> \u00b7 aet auth logout <provider>"));
    out();
    return 0;
  }

  if (action === "login") {
    if (!AUTH_PROVIDERS.includes(provider)) {
      process.stderr.write(`usage: aet auth login <${AUTH_PROVIDERS.join("|")}>\n`);
      return 2;
    }
    let apiKey = process.env[`AET_${provider.toUpperCase()}_API_KEY`] ?? "";
    if (!apiKey) {
      if (process.stdin.isTTY) {
        // Interactive: prompt on the terminal (stdin stays attached to the tty).
        apiKey = await promptOnTerminal(`API key for ${provider} (input hidden): `);
      } else {
        apiKey = (await readAllStdin()).trim();
      }
    }
    if (!apiKey) {
      process.stderr.write("no key provided\n");
      return 2;
    }
    await setCredential(provider, apiKey);
    out(`${style.green("stored")} ${provider} key ${style.dim(`\u2192 ${getPaths().authFile}`)}`);
    return 0;
  }

  if (action === "logout") {
    if (!AUTH_PROVIDERS.includes(provider)) {
      process.stderr.write(`usage: aet auth logout <${AUTH_PROVIDERS.join("|")}>\n`);
      return 2;
    }
    const removed = await clearCredential(provider);
    out(removed ? `${style.green("removed")} ${provider} credentials` : `${style.dim(`no stored credentials for ${provider}`)}`);
    return 0;
  }

  process.stderr.write("usage: aet auth [status|login <provider>|logout <provider>]\n");
  return 2;
}

async function readAllStdin(): Promise<string> {
  if (process.stdin.isTTY) return "";
  const chunks: Buffer[] = [];
  for await (const chunk of process.stdin) chunks.push(Buffer.from(chunk));
  return Buffer.concat(chunks).toString("utf8");
}

/** Read one line from the terminal without echoing it (API keys). */
function promptOnTerminal(prompt: string): Promise<string> {
  return new Promise((resolve) => {
    // Echo is suppressed by discarding readline's own writes; we print the
    // prompt ourselves on the real stdout.
    const sink = new Writable({
      write(_chunk, _encoding, callback) {
        callback();
      },
    });
    process.stdout.write(prompt);
    const rl = readline.createInterface({ input: process.stdin, output: sink, terminal: true });
    let settled = false;
    const finish = (value: string): void => {
      if (settled) return;
      settled = true;
      process.stdout.write("\n");
      rl.close();
      resolve(value);
    };
    rl.question("", (answer) => finish(answer.trim()));
    rl.on("close", () => finish(""));
  });
}

/* ------------------------------------------------------------- completions */

async function completionsCommand(argv: string[]): Promise<number> {
  const shell = (argv[0] ?? "").toLowerCase();

  if (shell === "bash") {
    process.stdout.write(`# bash completion for aet
_aet_complete() {
  local cur prev commands options
  cur="\${COMP_WORDS[COMP_CWORD]}"
  prev="\${COMP_WORDS[COMP_CWORD-1]}"
  commands="agents tools config sessions doctor mcp init team auth completions help version"
  options="--model --provider --agent --permission-mode --allowed-tools --disallowed-tools --max-turns --output-format --resume --continue --verbose --debug --no-color --plan --accept-edits --dangerously-skip-permissions --help --version -p -m -a -c -v -q -V -h"
  if [[ \${cur} == -* ]]; then
    COMPREPLY=( $(compgen -W "\${options}" -- \${cur}) )
  elif [[ \${COMP_CWORD} == 1 ]]; then
    COMPREPLY=( $(compgen -W "\${commands}" -- \${cur}) )
  fi
}
complete -F _aet_complete aet
`);
    return 0;
  }

  if (shell === "zsh") {
    process.stdout.write(`#compdef aet
_aet() {
  local -a commands
  commands=(agents tools config sessions doctor mcp init team auth completions help version)
  local -a options
  options=(
    '--model[Model id]:model:'
    '--provider[Provider]:provider:(anthropic openai openrouter groq deepseek ollama mock)'
    '--agent[Team role]:agent:'
    '--permission-mode[Permission mode]:mode:(default acceptEdits plan bypassPermissions)'
    '--output-format[Output format]:format:(text json stream-json)'
    '--continue[Continue last session]'
    '--resume[Resume session]:id:'
    '--verbose[Verbose output]'
    '--plan[Read-only mode]'
    '--accept-edits[Auto-approve edits]'
    '--dangerously-skip-permissions[No approvals]'
  )
  _arguments -C \\
    '1: :->command' \\
    '*:: :->args' \\
    $options
  case $state in
    command) _describe 'command' commands ;;
    args) case $words[1] in
      config) _values 'action' list get set reset ;;
      sessions) _values 'action' list resume delete ;;
      mcp) _values 'action' list add remove ping ;;
      auth) _values 'action' status login logout ;;
    esac ;;
  esac
}
_aet "$@"
`);
    return 0;
  }

  if (shell === "fish") {
    process.stdout.write(`complete -c aet -f
complete -c aet -n "__fish_use_subcommand" -a "agents" -d "List team roles"
complete -c aet -n "__fish_use_subcommand" -a "tools" -d "List tools"
complete -c aet -n "__fish_use_subcommand" -a "config" -d "Configuration"
complete -c aet -n "__fish_use_subcommand" -a "sessions" -d "Saved sessions"
complete -c aet -n "__fish_use_subcommand" -a "doctor" -d "Diagnostics"
complete -c aet -n "__fish_use_subcommand" -a "mcp" -d "MCP servers"
complete -c aet -n "__fish_use_subcommand" -a "init" -d "Scaffold .aet/"
complete -c aet -n "__fish_use_subcommand" -a "team" -d "Multi-agent pipeline"
complete -c aet -n "__fish_use_subcommand" -a "auth" -d "Credentials"
complete -c aet -n "__fish_use_subcommand" -a "help" -d "Help"
complete -c aet -l model -s m -d "Model id"
complete -c aet -l agent -s a -d "Team role"
complete -c aet -l print -s p -d "Non-interactive run"
complete -c aet -l plan -d "Read-only mode"
complete -c aet -l continue -s c -d "Continue last session"
`);
    return 0;
  }

  process.stderr.write("usage: aet completions [bash|zsh|fish]\n");
  return 2;
}

/* -------------------------------------------------------------------- help */

async function helpCommand(argv: string[]): Promise<number> {
  const topic = argv[0];
  if (!topic) {
    const { renderHelp } = await import("./help.js");
    process.stdout.write(`${renderHelp()}\n`);
    return 0;
  }
  const detail = renderCommandHelp(topic);
  if (!detail) {
    process.stderr.write(`no help topic "${topic}". Commands: ${COMMANDS.map((c) => c.name).join(", ")}\n`);
    return 1;
  }
  process.stdout.write(`${detail}\n\n`);
  return 0;
}

/** Used by `aet --version` and the team command's model listing. */
export function describeModels(): void {
  for (const model of listModels()) {
    out(`  ${model.id} ${style.dim(`${model.provider} \u00b7 ${model.contextWindow} ctx`)}`);
  }
}

export { BUILTIN_AGENTS, AUTHOR, AUTHOR_URL, ORGANIZATION, GLOBAL_OPTIONS };
