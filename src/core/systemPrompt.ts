/** System prompt construction: identity, environment, workspace instructions. */

import { spawnSync } from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { readTextFile } from "../util/fsx.js";
import { projectPaths } from "./paths.js";
import type { Config } from "./config.js";
import type { AgentDefinition } from "../team/agents.js";
import { AUTHOR, AUTHOR_URL, ORGANIZATION, REPO_URL, VERSION } from "../version.js";

export interface InstructionContext {
  files: Array<{ path: string; contents: string }>;
  git?: { branch: string; status: string; recent: string };
  readmeExcerpt?: string;
}

function runGit(cwd: string, args: string[]): string | null {
  try {
    const result = spawnSync("git", args, { cwd, encoding: "utf8", timeout: 4000, stdio: ["ignore", "pipe", "ignore"] });
    if (result.status !== 0 || result.error) return null;
    return (result.stdout ?? "").trim();
  } catch {
    return null;
  }
}

const instructionCache = new Map<string, InstructionContext>();

export async function loadInstructionContext(cwd: string, force = false): Promise<InstructionContext> {
  const cached = instructionCache.get(cwd);
  if (cached && !force) return cached;

  const files: Array<{ path: string; contents: string }> = [];
  const seen = new Set<string>();
  for (const candidate of projectPaths(cwd).instructions) {
    if (seen.has(candidate)) continue;
    seen.add(candidate);
    const contents = await readTextFile(candidate);
    if (contents && contents.trim().length > 0) {
      files.push({ path: candidate, contents: contents.trim() });
    }
  }

  const context: InstructionContext = { files };

  const branch = runGit(cwd, ["rev-parse", "--abbrev-ref", "HEAD"]);
  if (branch) {
    const status = runGit(cwd, ["status", "--porcelain"]) ?? "";
    const statusLines = status ? status.split("\n").filter(Boolean) : [];
    const recent = runGit(cwd, ["log", "--oneline", "-5"]) ?? "";
    context.git = {
      branch,
      status:
        statusLines.length === 0
          ? "clean"
          : statusLines.slice(0, 20).join("\n") + (statusLines.length > 20 ? `\n\u2026 ${statusLines.length - 20} more` : ""),
      recent,
    };
  }

  const readme = await readTextFile(path.join(cwd, "README.md"));
  if (readme) context.readmeExcerpt = readme.slice(0, 2500);

  instructionCache.set(cwd, context);
  return context;
}

function detectTooling(cwd: string): string[] {
  const hints: string[] = [];
  const markers: Array<[string, string]> = [
    ["package.json", "Node.js/npm"],
    ["pnpm-lock.yaml", "pnpm"],
    ["yarn.lock", "yarn"],
    ["Cargo.toml", "Rust/cargo"],
    ["pyproject.toml", "Python/pyproject"],
    ["requirements.txt", "Python"],
    ["go.mod", "Go"],
    ["Gemfile", "Ruby"],
    ["composer.json", "PHP"],
    ["Dockerfile", "Docker"],
    ["docker-compose.yml", "Docker Compose"],
  ];
  for (const [marker, label] of markers) {
    if (fs.existsSync(path.join(cwd, marker)) && !hints.includes(label)) hints.push(label);
  }
  return hints;
}

export interface SystemPromptOptions {
  cwd: string;
  config: Config;
  agent?: AgentDefinition;
  /** Extra system prompt appended by the user. */
  append?: string;
  /** Include heavier workspace context (README excerpt, instruction files). */
  includeWorkspace?: boolean;
}

export function baseIdentity(agent?: AgentDefinition): string {
  const role =
    agent && agent.name !== "general"
      ? `\nYour role in the team: ${agent.name.toUpperCase()} - ${agent.description}\nFollow the role instructions below for how to behave; you still have the full workspace toolset unless tools were restricted.\n\n<role_instructions>\n${agent.systemPrompt}\n</role_instructions>\n`
      : "";

  return `You are ${"AI Engineering Team"} (CLI: \`aet\`), version ${VERSION} - an autonomous agentic coding assistant created by ${AUTHOR} (${AUTHOR_URL}), founder of ${ORGANIZATION}. Repository: ${REPO_URL}.${role}`;
}

export async function buildSystemPrompt(options: SystemPromptOptions): Promise<string> {
  const { cwd, config, agent } = options;
  const context = options.includeWorkspace === false ? { files: [] } : await loadInstructionContext(cwd);
  const parts: string[] = [];

  parts.push(baseIdentity(agent));

  const environment = [
    "## Environment",
    `- OS: ${os.platform()} ${os.release()} (${os.arch()})`,
    `- Date: ${new Date().toISOString().slice(0, 16)}Z`,
    `- Working directory: ${cwd}`,
    `- Node: ${process.versions.node}`,
    context.git ? `- Git branch: ${context.git.branch} (working tree: ${context.git.status === "clean" ? "clean" : "modified"})` : "- Git: not a repository",
    detectTooling(cwd).length > 0 ? `- Detected tooling: ${detectTooling(cwd).join(", ")}` : undefined,
  ]
    .filter(Boolean)
    .join("\n");
  parts.push(environment);

  parts.push(`## How you work
- You operate autonomously in this workspace through tools. The user is not watching every step: plan, act, verify, then report.
- Read files before editing them. Use exact paths (prefer Glob/Grep to discover files - never guess paths).
- Make the smallest coherent change that solves the task. Follow the existing style, naming and structure of the repo.
- Verify your work: run the project's build/tests/lint when available. If you cannot verify, say so explicitly.
- Prefer Edit over Write for existing files. Keep tool loops tight; do not repeat failing commands without changing something.
- If a task is ambiguous, choose the most reasonable interpretation, state your assumption, and continue.
- Never print secrets or credentials. Never run destructive commands (rm -rf, git reset --hard, force pushes) unless explicitly asked.
- Update the todo list when the task has more than two steps.`);

  parts.push(`## Response style
- Be concise and concrete. Lead with the outcome.
- Reference files as \`path/to/file.ts:12\`.
- Use short paragraphs and bullets. No filler, no restating the prompt, no apologies.
- When finished, summarize: what changed, why, and how it was verified.`);

  if (context.files.length > 0) {
    const blocks = context.files
      .map((file) => `<instructions file="${path.relative(cwd, file.path) || file.path}">\n${file.contents.slice(0, 8000)}\n</instructions>`)
      .join("\n\n");
    parts.push(`## Workspace instructions\nThe following project instruction files are in effect and take precedence over generic guidance:\n\n${blocks}`);
  } else if (context.readmeExcerpt) {
    parts.push(`## Project (README excerpt)\n${context.readmeExcerpt}`);
  }

  if (config.verbose) {
    parts.push(`## Verbose mode\nExplain each step briefly as you take it.`);
  }

  if (options.append?.trim()) {
    parts.push(`## Additional instructions from the user\n${options.append.trim()}`);
  }

  return parts.join("\n\n");
}
