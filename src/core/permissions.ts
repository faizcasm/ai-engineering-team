/**
 * Permission engine.
 *
 * Every tool invocation is evaluated against, in order:
 *   1. hard deny rules        -> deny
 *   2. hard allow rules       -> allow
 *   3. permission mode        -> allow / deny / ask
 *   4. read-only heuristics   -> allow
 *   5. ask the user through a gate (falls back to deny when unattended)
 *
 * Rule syntax (compatible with Claude Code's `settings.json` allow lists):
 *   "Read"                      any Read call
 *   "Bash"                      any shell command
 *   "Bash(git:*)"               shell commands starting with `git `
 *   "Bash(npm test)"            exactly `npm test`
 *   "Write(/home/me/x.ts)"      writes to that path
 *   "Edit(src/**)"              edits under src/
 *   "WebFetch(domain:github.com)"
 *   "mcp__github__search"       an MCP tool
 */

import * as path from "node:path";
import { matchGlob } from "../util/text.js";
import type { PermissionMode } from "./config.js";

export interface PermissionRequest {
  tool: string;
  input: unknown;
  /** Human readable target (path / command / url) derived by the tool. */
  target?: string;
  /** Where the request originated. */
  source?: "main" | "subagent";
}

export interface PermissionDecision {
  action: "allow" | "deny";
  reason?: string;
  /** True when the user chose "always allow" for this target. */
  remembered?: boolean;
}

export interface PermissionGate {
  /** Ask the human. Must resolve with allow/deny. */
  ask(request: PermissionRequest, reason: string): Promise<PermissionDecision>;
}

export interface PermissionContext {
  mode: PermissionMode;
  allow: string[];
  deny: string[];
  gate?: PermissionGate;
  /** Non-interactive sessions have no gate; asking resolves to deny. */
  interactive: boolean;
  cwd: string;
}

export const EDIT_TOOLS = new Set(["Write", "Edit", "MultiEdit", "NotebookEdit"]);
export const READ_ONLY_TOOLS = new Set(["Read", "Glob", "Grep", "LS", "TodoWrite", "TaskList", "BashOutput", "KillShell"]);

const READ_ONLY_COMMANDS = [
  "ls", "pwd", "cat", "head", "tail", "wc", "which", "whoami", "date", "uname",
  "echo", "printenv", "env", "stat", "file", "du", "df", "free", "node -v", "npm -v",
  "git status", "git log", "git diff", "git show", "git branch", "git remote -v",
  "git config --get", "git stash list", "git ls-files", "git blame", "git describe",
  "grep", "rg", "find", "tree", "ps", "hostname", "id", "python --version",
  "tsc --version", "tsc --noEmit", "npx tsc --noEmit", "lsb_release", "curl -sI", "ping -c",
];

/** Extract the interesting target from a tool invocation for display/rules. */
export function describeTarget(tool: string, input: unknown): string | undefined {
  const args = (input ?? {}) as Record<string, unknown>;
  switch (tool) {
    case "Bash":
      return typeof args.command === "string" ? args.command : undefined;
    case "Read":
    case "Write":
      return typeof args.file_path === "string" ? args.file_path : undefined;
    case "Edit":
    case "MultiEdit":
      return typeof args.file_path === "string" ? args.file_path : undefined;
    case "Glob":
    case "Grep":
      return typeof args.path === "string" ? args.path : (args.pattern as string | undefined);
    case "LS":
      return typeof args.path === "string" ? args.path : undefined;
    case "WebFetch":
      return typeof args.url === "string" ? args.url : undefined;
    case "Task":
      return typeof args.subagent_type === "string" ? args.subagent_type : undefined;
    default:
      return typeof args.name === "string" ? args.name : undefined;
  }
}

interface ParsedRule {
  tool: string;
  qualifier?: string;
}

export function parseRule(rule: string): ParsedRule {
  const trimmed = rule.trim();
  const match = /^([A-Za-z0-9_\-.*]+)(?:\((.*)\))?$/s.exec(trimmed);
  if (!match) return { tool: trimmed };
  const [, tool, qualifier] = match;
  return { tool: tool!, qualifier };
}

function normalizePath(value: string, cwd: string): string {
  const resolved = path.isAbsolute(value) ? path.resolve(value) : path.resolve(cwd, value);
  return resolved;
}

function pathMatches(pattern: string, target: string, cwd: string): boolean {
  // Bare directory match: "src" allows anything under src/.
  const normalizedTarget = normalizePath(target, cwd);
  const absolutePattern = path.isAbsolute(pattern)
    ? pattern
    : pattern.includes("*") || pattern.includes("/")
      ? path.resolve(cwd, pattern)
      : null;

  if (absolutePattern) {
    if (matchGlob(absolutePattern, normalizedTarget)) return true;
    if (matchGlob(`${absolutePattern}/**`, normalizedTarget)) return true;
    // Prefix directory form "src/**" already covered by matchGlob above.
    return matchGlob(`${absolutePattern}/**/*`, normalizedTarget);
  }

  // Relative-to-cwd glob evaluated on the relative path.
  const relative = path.relative(cwd, normalizedTarget);
  if (matchGlob(pattern, relative)) return true;
  if (matchGlob(`${pattern}/**`, relative)) return true;
  if (matchGlob(`${pattern}/**/*`, relative)) return true;
  if (relative.startsWith(`${pattern}${path.sep}`)) return true;
  return false;
}

function bashQualifierMatches(qualifier: string, command: string): boolean {
  const trimmed = command.trim();
  if (qualifier === "*") return true;
  if (qualifier.endsWith(":*")) {
    const prefix = qualifier.slice(0, -2);
    return trimmed === prefix || trimmed.startsWith(`${prefix} `) || trimmed.startsWith(prefix);
  }
  if (qualifier.endsWith("/")) return trimmed.startsWith(qualifier);
  return trimmed === qualifier || trimmed.startsWith(`${qualifier} `);
}

function qualifierMatches(qualifier: string | undefined, tool: string, target: string | undefined, cwd: string): boolean {
  if (qualifier === undefined) return true;
  if (!target) return false;

  if (tool === "Bash") return bashQualifierMatches(qualifier, target);
  if (tool === "WebFetch") {
    if (qualifier.startsWith("domain:")) {
      const domain = qualifier.slice("domain:".length).toLowerCase().replace(/^www\./, "");
      try {
        const host = new URL(target).hostname.toLowerCase().replace(/^www\./, "");
        return host === domain || host.endsWith(`.${domain}`);
      } catch {
        return false;
      }
    }
    return matchGlob(qualifier, target);
  }
  if (tool === "Task") return qualifier === target || matchGlob(qualifier, target);
  // File-ish tools: path glob.
  return pathMatches(qualifier, target, cwd);
}

export function ruleMatches(rule: string, request: PermissionRequest, cwd: string): boolean {
  const parsed = parseRule(rule);
  // The tool position may itself be a glob (`mcp__github__*`, `*`).
  if (parsed.tool !== "*" && parsed.tool !== request.tool) {
    if (!matchGlob(parsed.tool, request.tool)) return false;
  }
  return qualifierMatches(parsed.qualifier, request.tool, request.target, cwd);
}

export function isReadOnlyCommand(command: string): boolean {
  const trimmed = command.trim().replace(/^[&\s]+/, "");
  // Disqualifiers: anything that mutates state or chains a mutating command.
  if (/[;&|]|&&|\|\|/.test(trimmed)) {
    const segments = trimmed.split(/[;&|]+/).map((s) => s.trim()).filter(Boolean);
    if (segments.length === 0) return false;
    // Allow chained read-only commands such as `git status && git log`.
    return segments.every((segment) => isReadOnlyCommand(segment));
  }
  if (trimmed.startsWith("!")) return false;
  // Output redirection (>, >>, tee) writes to disk - never read-only.
  if (/(^|[^0-9])>/.test(trimmed) || /\btee\b/.test(trimmed)) return false;
  if (/\brm\b|\bmv\b|\bcp\b|\bchmod\b|\bchown\b|\bsudo\b|\bkill\b|\bwrite\b/.test(trimmed)) return false;
  return READ_ONLY_COMMANDS.some((prefix) => trimmed === prefix || trimmed.startsWith(`${prefix} `));
}

/** Suggest a persistent allow rule for "always allow" responses. */
export function suggestAllowRule(request: PermissionRequest): string {
  const target = request.target ?? "";
  switch (request.tool) {
    case "Bash": {
      const first = target.trim().split(/\s+/)[0] ?? "*";
      return `Bash(${first}:*)`;
    }
    case "WebFetch": {
      try {
        return `WebFetch(domain:${new URL(target).hostname})`;
      } catch {
        return "WebFetch(*)";
      }
    }
    case "Read":
    case "Write":
    case "Edit":
    case "MultiEdit":
    case "Glob":
    case "Grep":
    case "LS": {
      if (!target) return request.tool;
      const extension = path.extname(target);
      // Prefer a directory-scoped rule so the whole folder stays editable.
      const dir = path.dirname(target);
      if (dir && dir !== "." && dir !== "/") {
        return `${request.tool}(${dir.split(path.sep).join("/")}/**)`;
      }
      return extension ? `${request.tool}(**/*${extension})` : request.tool;
    }
    default:
      return request.tool;
  }
}

/** Plan mode blocks everything that could mutate state. */
function isMutating(tool: string, input: unknown): boolean {
  if (tool === "Bash") {
    const command = String((input as { command?: string })?.command ?? "");
    return !isReadOnlyCommand(command);
  }
  if (EDIT_TOOLS.has(tool)) return true;
  if (tool === "Task" || tool === "WebFetch" || tool === "MCPTool") return true;
  // MCP tools (mcp__server__tool) can write to disk or call APIs - not read-only.
  if (tool.startsWith("mcp__")) return true;
  return false;
}

export async function checkPermission(
  request: PermissionRequest,
  ctx: PermissionContext,
): Promise<PermissionDecision> {
  const target = request.target ?? describeTarget(request.tool, request);

  for (const rule of ctx.deny) {
    if (ruleMatches(rule, { ...request, target }, ctx.cwd)) {
      return { action: "deny", reason: `matched deny rule ${rule}` };
    }
  }

  for (const rule of ctx.allow) {
    if (ruleMatches(rule, { ...request, target }, ctx.cwd)) {
      return { action: "allow", reason: `allowed by ${rule}` };
    }
  }

  if (ctx.mode === "bypassPermissions") {
    return { action: "allow", reason: "bypassPermissions mode" };
  }

  if (ctx.mode === "plan" && isMutating(request.tool, request.input)) {
    return {
      action: "deny",
      reason: "plan mode is read-only - re-run with --permission-mode default to make changes",
    };
  }

  if (ctx.mode === "acceptEdits" && EDIT_TOOLS.has(request.tool)) {
    return { action: "allow", reason: "acceptEdits mode" };
  }

  // Safe, read-only work never needs approval.
  if (READ_ONLY_TOOLS.has(request.tool)) {
    return { action: "allow", reason: "read-only tool" };
  }
  if (request.tool === "Bash" && isReadOnlyCommand(String((request.input as { command?: string })?.command ?? ""))) {
    return { action: "allow", reason: "read-only shell command" };
  }

  if (!ctx.interactive || !ctx.gate) {
    return {
      action: "deny",
      reason:
        "approval required but the session is non-interactive (use --dangerously-skip-permissions, --permission-mode bypassPermissions, or an allow rule)",
    };
  }

  const answer = await ctx.gate.ask({ ...request, target }, "approval required");
  if (answer.action === "allow" && answer.remembered && target) {
    return { action: "allow", reason: "remembered", remembered: true };
  }
  return answer;
}
