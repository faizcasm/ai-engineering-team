/** Shared CLI option specs and help rendering. */

import { style } from "../util/color.js";
import type { OptionSpec } from "./args.js";
import { AUTHOR, AUTHOR_URL, CREDIT, ORGANIZATION, REPO_URL, VERSION } from "../version.js";

export const COMMANDS = [
  { name: "agents", description: "List the AI engineering team roles (and custom agents)" },
  { name: "tools", description: "List available tools, including MCP tools" },
  { name: "config", description: "Get/set configuration: aet config get <key>, set <key> <value>, list" },
  { name: "sessions", description: "List/resume/delete saved sessions: aet sessions [list|resume <id>|delete <id>]" },
  { name: "doctor", description: "Diagnose installation, credentials, MCP servers and backend health" },
  { name: "mcp", description: "Manage MCP servers: aet mcp [list|add|remove|ping]" },
  { name: "init", description: "Scaffold .aet/ (config, agents, commands) in the current project" },
  { name: "team", description: "Run a multi-agent plan -> delegate -> review pipeline: aet team \"<goal>\"" },
  { name: "auth", description: "Store/clear API keys: aet auth [login|logout|status] [provider]" },
  { name: "completions", description: "Print a shell completion script: aet completions [bash|zsh|fish]" },
  { name: "version", description: "Print version and author information (same as --version)" },
  { name: "help", description: "Show help for aet or a subcommand" },
] as const;

export const GLOBAL_OPTIONS: OptionSpec[] = [
  { name: "print", short: "p", type: "boolean", description: "Non-interactive: run one turn, print the answer, exit" },
  { name: "model", short: "m", type: "string", placeholder: "<model>", description: "Model id (e.g. claude-sonnet-4-5, gpt-5.1, openrouter/deepseek/...)" },
  { name: "provider", type: "string", placeholder: "<id>", values: ["anthropic", "openai", "openrouter", "groq", "deepseek", "ollama", "mock"], description: "Override provider resolution" },
  { name: "agent", short: "a", type: "string", placeholder: "<role>", description: "Team role for this run (see `aet agents`)" },
  { name: "permission-mode", type: "string", values: ["default", "acceptEdits", "plan", "bypassPermissions"], placeholder: "<mode>", description: "Permission policy (default: default)" },
  { name: "accept-edits", type: "boolean", description: "Shorthand for --permission-mode acceptEdits" },
  { name: "plan", type: "boolean", description: "Shorthand for --permission-mode plan (read-only)" },
  { name: "dangerously-skip-permissions", type: "boolean", description: "No approval prompts at all (bypassPermissions)" },
  { name: "allowed-tools", type: "string", placeholder: "<rules>", description: "Comma-separated allow rules, e.g. \"Bash(git:*),Write(src/**)\"" },
  { name: "disallowed-tools", type: "string", placeholder: "<rules>", description: "Comma-separated deny rules" },
  { name: "max-turns", type: "number", placeholder: "<n>", description: "Max tool iterations per turn (default 60)" },
  { name: "max-tokens", type: "number", placeholder: "<n>", description: "Max output tokens per request" },
  { name: "temperature", type: "number", placeholder: "<t>", description: "Sampling temperature" },
  { name: "append-system-prompt", type: "string", placeholder: "<text>", description: "Extra instructions appended to the system prompt" },
  { name: "output-format", type: "string", values: ["text", "json", "stream-json"], placeholder: "<fmt>", description: "Output format for --print (default: text)" },
  { name: "continue", short: "c", type: "boolean", description: "Continue the most recent session in this directory" },
  { name: "resume", type: "string", optional: true, placeholder: "[id]", description: "Resume a session (omit value for the most recent one)" },
  { name: "cwd", type: "string", placeholder: "<dir>", description: "Run as if started in <dir>" },
  { name: "url", type: "string", placeholder: "<url>", description: "MCP server URL (aet mcp add)" },
  { name: "env", type: "string", placeholder: "<K=V,...>", description: "Environment variables for an MCP server" },
  { name: "global", type: "boolean", description: "Write to ~/.aet instead of the project .aet/" },
  { name: "force", short: "f", type: "boolean", description: "Overwrite existing files (aet init)" },
  { name: "verbose", short: "v", type: "boolean", description: "Verbose output (tool results, token counts)" },
  { name: "quiet", short: "q", type: "boolean", description: "Suppress non-essential output" },
  { name: "debug", type: "boolean", description: "Debug logging to stderr" },
  { name: "no-color", type: "boolean", description: "Disable ANSI colors" },
  { name: "version", short: "V", type: "boolean", description: "Print version and exit" },
  { name: "help", short: "h", type: "boolean", description: "Show help" },
];

/** Options accepted only by a specific subcommand (`aet <command> --x`). */
export const COMMAND_OPTIONS: Record<string, OptionSpec[]> = {
  team: [
    { name: "plan-only", type: "boolean", description: "Stop after the plan is produced" },
    { name: "max-parallel", type: "number", placeholder: "<n>", description: "How many subagents run at once (default 3)" },
  ],
  tools: [
    { name: "no-mcp", type: "boolean", description: "Do not connect to MCP servers to list their tools" },
  ],
};

export function renderHelp(): string {
  const lines: string[] = [];
  lines.push(`${style.bold("aet")} - ${style.cyan("AI Engineering Team")} v${VERSION}`);
  lines.push(style.dim("Agentic coding CLI with a built-in team of AI engineers. Open source, MIT licensed."));
  lines.push("");
  lines.push(`${style.bold("USAGE")}`);
  lines.push("  aet [options] [prompt...]");
  lines.push("  aet <command> [args]");
  lines.push("");
  lines.push(`${style.bold("COMMANDS")}`);
  for (const command of COMMANDS) {
    lines.push(`  ${style.cyan(command.name.padEnd(14))} ${command.description}`);
  }
  lines.push("");
  lines.push(`${style.bold("OPTIONS")}`);
  for (const option of GLOBAL_OPTIONS) {
    const short = option.short ? `-${option.short}, ` : "    ";
    const value = option.type === "boolean" ? "" : ` ${option.placeholder ?? "<value>"}`;
    lines.push(`  ${short}--${option.name}${value}`.padEnd(34) + ` ${style.dim(option.description)}`);
  }
  lines.push("");
  lines.push(`${style.bold("EXAMPLES")}`);
  lines.push(`  ${style.dim("$")} aet "add rate limiting to the /api/users endpoint"`);
  lines.push(`  ${style.dim("$")} aet -p --output-format json "summarise this repo"`);
  lines.push(`  ${style.dim("$")} aet --permission-mode plan "explain the auth flow"`);
  lines.push(`  ${style.dim("$")} aet team "ship a REST API with tests and CI"`);
  lines.push(`  ${style.dim("$")} aet --agent qa-engineer "find bugs in src/graph"`);
  lines.push(`  ${style.dim("$")} aet --provider mock "offline demo run"`);
  lines.push(`  ${style.dim("$")} aet doctor`);
  lines.push("");
  lines.push(`${style.bold("PERMISSION MODES")}`);
  lines.push(`  ${style.cyan("default")}            ask before edits and non-read-only commands`);
  lines.push(`  ${style.cyan("acceptEdits")}        auto-approve file edits, still ask for shell`);
  lines.push(`  ${style.cyan("plan")}               read-only research, no modifications`);
  lines.push(`  ${style.cyan("bypassPermissions")}  never ask (also --dangerously-skip-permissions)`);
  lines.push("");
  lines.push(style.dim(`Author: ${CREDIT}`));
  lines.push(style.dim(`${REPO_URL} | MIT License`));
  lines.push("");
  lines.push(style.dim("Run `aet help <command>` for details on a command."));
  return lines.join("\n");
}

export function renderCommandHelp(name: string): string | null {
  const details: Record<string, string[]> = {
    team: [
      "aet team [options] \"<goal>\"",
      "",
      "Runs the full pipeline:",
      "  1. tech-lead breaks the goal into tasks and assigns roles",
      "  2. specialists execute in parallel (bounded concurrency)",
      "  3. reviewer inspects the result and the report is printed",
      "",
      "Options:",
      "  --plan-only        stop after the plan is produced",
      "  --max-parallel <n> how many subagents run at once (default 3)",
      "  --model <id>       model override for all roles",
    ],
    mcp: [
      "aet mcp list                     show configured servers",
      "aet mcp add <name> <command...>  add a stdio server (e.g. npx -y @modelcontextprotocol/server-filesystem)",
      "aet mcp add <name> --url <url>   add an HTTP server",
      "aet mcp remove <name>            remove a server",
      "aet mcp ping [name]              check server health",
      "",
      "Servers are stored in .aet/mcp.json (project) or ~/.aet/mcp.json (--global).",
    ],
    config: [
      "aet config list                   print merged configuration",
      "aet config get <key>              read one value (dot paths allowed)",
      "aet config set <key> <value>      write to ~/.aet/config.json",
      "",
      "Keys: model, provider, agent, permissionMode, allowedTools,",
      "      disallowedTools, contextWindow, maxTokens, maxTurns, autoCompact,",
      "      summarizeModel, theme, verbose, debug, backendUrl, mcpEnabled",
    ],
    auth: [
      "aet auth status                   which providers have credentials",
      "aet auth login <provider>         store a key in ~/.aet/auth.json (reads value from stdin if not given)",
      "aet auth logout <provider>        remove a stored key",
      "",
      "Providers: anthropic, openai, openrouter, groq, deepseek",
      "Env vars always win: ANTHROPIC_API_KEY, OPENAI_API_KEY, ...",
    ],
    sessions: [
      "aet sessions list                 recent sessions with ids",
      "aet sessions resume <id>          continue a session",
      "aet sessions delete <id>          delete a session",
      "",
      "Sessions live in ~/.aet/sessions/*.jsonl",
    ],
    init: [
      "aet init                          create .aet/ in the current project",
      "",
      "Writes: .aet/config.json, AET.md, .aet/agents/backend-expert.md,",
      "        .aet/commands/review.md and updates .gitignore if needed.",
    ],
    completions: [
      "aet completions bash              source <(aet completions bash)",
      "aet completions zsh               aet completions zsh > ~/.zfunc/_aet",
      "aet completions fish              aet completions fish > ~/.config/fish/completions/aet.fish",
    ],
  };

  const detail = details[name];
  if (!detail) {
    const command = (COMMANDS as ReadonlyArray<{ name: string; description: string }>).find((entry) => entry.name === name);
    if (!command) return null;
    return `${style.bold(`aet ${command.name}`)}\n\n  ${command.description}\n\nRun \`aet help ${command.name}\` for extended usage where available.`;
  }
  return [`${style.bold(`aet ${name}`)}`, "", ...detail.map((line) => (line.length > 0 && !line.startsWith("  ") && line.includes(" ") ? `  ${line}` : line))].join("\n");
}

export function renderVersion(): string {
  return [
    `aet/${VERSION} (${process.platform}-${process.arch}) node-${process.versions.node}`,
    `AI Engineering Team - open source agentic coding CLI`,
    `Copyright (c) 2026 ${AUTHOR} (${AUTHOR_URL}) - Founder of ${ORGANIZATION}`,
    `License: MIT | ${REPO_URL}`,
  ].join("\n");
}
