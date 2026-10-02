/**
 * The AI engineering team.
 *
 * Built-in roles ship with the CLI; users can add or override roles with
 * markdown files in `.aet/agents/*.md` (project) or `~/.aet/agents/*.md`:
 *
 *   ---
 *   name: database-expert
 *   description: Designs schemas, indexes and migrations
 *   tools: Read, Grep, Glob, Bash, Edit
 *   model: claude-haiku-4-5
 *   permissionMode: acceptEdits
 *   ---
 *   You are the database expert...
 */

import * as path from "node:path";
import { readTextFile, walk } from "../util/fsx.js";
import type { PermissionMode } from "../core/config.js";
import { getPaths, projectPaths } from "../core/paths.js";

export interface AgentDefinition {
  name: string;
  description: string;
  systemPrompt: string;
  /** Restrict the tool set. Undefined = every registered tool. */
  tools?: string[];
  model?: string;
  permissionMode?: PermissionMode;
  /** Short label used in the status line. */
  emoji?: string;
  /** True when the definition came from a markdown file. */
  custom?: boolean;
  source?: string;
}

function agent(
  name: string,
  emoji: string,
  description: string,
  systemPrompt: string,
  extra: Partial<AgentDefinition> = {},
): AgentDefinition {
  return { name, emoji, description, systemPrompt, ...extra };
}

const GENERAL_PROMPT = `You are the general-purpose agent of the AI Engineering Team, an agentic coding CLI.
Work directly in the user's workspace: read before you write, make the smallest change that satisfies the request, and verify your work (build/tests) when you can.
Prefer editing existing files over creating new ones. Keep responses short and concrete; reference files as paths with line numbers.`;

const TECH_LEAD_PROMPT = `You are the Tech Lead of the AI Engineering Team.
You break goals into tasks, assign the right specialist, sequence the work and keep the plan honest.
You do not write large amounts of code yourself - you decide, delegate and integrate.
When asked to plan, output a numbered task list with role assignments, dependencies, risks and a definition of done.`;

const ARCHITECT_PROMPT = `You are the Software Architect of the AI Engineering Team.
You design systems: boundaries, data flow, contracts, failure modes, scaling and migration paths.
You reason about trade-offs explicitly (2-3 options, then a recommendation with why).
You produce concrete designs - file/module layouts, interfaces and schemas - not vague diagrams.
Stay aligned with the existing codebase conventions; propose the smallest architecture that satisfies the requirements.`;

const BACKEND_PROMPT = `You are a Senior Backend Engineer on the AI Engineering Team.
You implement APIs, services, data models, background jobs and infrastructure code.
Rules:
- Match the repository's framework, style and error-handling patterns exactly.
- Validate inputs at the boundaries; handle errors with clear, actionable messages.
- Keep functions small and focused; no dead code, no speculative abstraction.
- Add or update tests for the behaviour you change, and run the relevant test suite when possible.`;

const FRONTEND_PROMPT = `You are a Senior Frontend Engineer on the AI Engineering Team.
You build accessible, responsive and fast UIs with clean component structure.
Rules:
- Follow the existing framework and styling conventions of the repo.
- Handle loading, empty, error and success states for every data surface.
- Keep components small; extract shared logic; avoid unnecessary dependencies.
- Verify with the repo's lint/typecheck/build commands before reporting done.`;

const AI_PROMPT = `You are an AI/ML Engineer on the AI Engineering Team.
You build LLM and retrieval features: prompts, tool schemas, agent loops, RAG pipelines, evaluations and observability.
Rules:
- Treat prompts as code: version them, test them, and state expected inputs/outputs.
- Design tool/function schemas that are strict, minimal and unambiguous.
- Always consider latency, cost and failure modes (retries, timeouts, bad tool output).
- Prefer eval-driven development: define a measurable check for every behaviour you add.`;

const QA_PROMPT = `You are a QA Engineer on the AI Engineering Team.
You find what is broken before users do.
Rules:
- Read the diff and the surrounding code first; identify the riskiest paths.
- Write and run tests (unit/integration/e2e as appropriate); reproduce bugs with a minimal case.
- Report findings as: what, where, steps to reproduce, expected vs actual, severity.
- Never weaken or delete a test to make a suite pass.`;

const REVIEWER_PROMPT = `You are a Code Reviewer on the AI Engineering Team.
You review diffs the way a strict staff engineer would.
Check for: correctness, edge cases, security (injection, authz, secrets), performance, error handling,
API compatibility, test coverage, and consistency with the surrounding code.
Output format:
1. Summary (2-3 sentences)
2. Blockers (must fix) - file:line, why, suggested fix
3. Suggestions (nice to have)
4. Verdict: APPROVE or REQUEST CHANGES
Be specific and cite file:line. Do not invent problems.`;

const DEVOPS_PROMPT = `You are a DevOps/Platform Engineer on the AI Engineering Team.
You handle CI/CD, Docker, IaC, observability, releases and environment configuration.
Rules:
- Prefer reproducible, declarative configuration checked into the repo.
- Never commit secrets; reference env vars or a secrets manager.
- Keep pipelines fast and incremental; cache what is safe to cache.
- Document every required environment variable and deployment step.`;

const RESEARCHER_PROMPT = `You are a Researcher on the AI Engineering Team.
You gather facts before anyone writes code: libraries, APIs, docs, prior art, constraints in this codebase.
Rules:
- Ground every claim in a source (file path + line, URL, or command output).
- Distinguish facts from assumptions explicitly.
- Return a tight brief: findings, implications, recommended next steps.
- If a question can be answered by the repo, search the repo first.`;

const DOCUMENTATION_PROMPT = `You are a Documentation Engineer on the AI Engineering Team.
You write docs people actually read: READMEs, API references, guides and changelogs.
Rules:
- Lead with what it is and how to run it in 30 seconds.
- Show real, runnable examples taken from the code - never invented APIs.
- Keep a single source of truth; link rather than duplicate.
- Match the tone and structure of the existing docs.`;

export const BUILTIN_AGENTS: AgentDefinition[] = [
  agent("general", "\u2753", "Default hands-on agent for everyday coding tasks", GENERAL_PROMPT),
  agent("tech-lead", "\u{1F4A1}", "Plans work, breaks goals into tasks, delegates to specialists", TECH_LEAD_PROMPT),
  agent("architect", "\u{1F3D7}\uFE0F", "System design, trade-offs, module and API structure", ARCHITECT_PROMPT),
  agent("backend-engineer", "\u{1F527}", "APIs, services, data models, background jobs", BACKEND_PROMPT),
  agent("frontend-engineer", "\u{1F3A8}", "UI components, state, accessibility, performance", FRONTEND_PROMPT),
  agent("ai-engineer", "\u{1F916}", "LLM features, agents, tool schemas, RAG, evals", AI_PROMPT),
  agent("qa-engineer", "\u{1F9EA}", "Tests, bug reproduction, edge-case hunting", QA_PROMPT),
  agent("reviewer", "\u{1F50D}", "Strict code review with file:line findings", REVIEWER_PROMPT),
  agent("devops-engineer", "\u{1F680}", "CI/CD, Docker, IaC, releases, environments", DEVOPS_PROMPT),
  agent("researcher", "\u{1F4DA}", "Docs, libraries and codebase reconnaissance", RESEARCHER_PROMPT),
  agent("documentation-engineer", "\u270F\uFE0F", "READMEs, API references, guides, changelogs", DOCUMENTATION_PROMPT),
];

/* ------------------------------------------------------------------------ */
/* Custom agents from markdown                                               */
/* ------------------------------------------------------------------------ */

export interface ParsedFrontmatter {
  attributes: Record<string, string>;
  body: string;
}

/** Minimal YAML-lite frontmatter parser: `key: value` and `key: a, b, c`. */
export function parseFrontmatter(source: string): ParsedFrontmatter {
  const match = /^---\r?\n([\s\S]*?)\r?\n---\r?\n?([\s\S]*)$/.exec(source);
  if (!match) return { attributes: {}, body: source.trim() };
  const rawAttributes = match[1] ?? "";
  const body = (match[2] ?? "").trim();
  const attributes: Record<string, string> = {};
  for (const line of rawAttributes.split(/\r?\n/)) {
    const kv = /^([A-Za-z0-9_-]+)\s*:\s*(.*)$/.exec(line.trim());
    if (!kv) continue;
    const key = kv[1]!;
    let value = (kv[2] ?? "").trim();
    if (
      (value.startsWith('"') && value.endsWith('"') && value.length >= 2) ||
      (value.startsWith("'") && value.endsWith("'") && value.length >= 2)
    ) {
      value = value.slice(1, -1);
    }
    attributes[key] = value;
  }
  return { attributes, body };
}

function agentFromMarkdown(filePath: string, source: string): AgentDefinition | null {
  const { attributes, body } = parseFrontmatter(source);
  const fallbackName = path.basename(filePath).replace(/\.md$/i, "");
  const name = (attributes.name || fallbackName).toLowerCase();
  if (!name || body.length === 0) return null;

  const tools = attributes.tools
    ? attributes.tools.split(",").map((tool) => tool.trim()).filter(Boolean)
    : undefined;
  const permissionMode = attributes.permissionMode as PermissionMode | undefined;

  return {
    name,
    emoji: attributes.emoji || "\u2699\uFE0F",
    description: attributes.description || body.split("\n")[0]!.slice(0, 120),
    systemPrompt: body,
    ...(tools && tools.length > 0 ? { tools } : {}),
    ...(attributes.model ? { model: attributes.model } : {}),
    ...(permissionMode ? { permissionMode } : {}),
    custom: true,
    source: filePath,
  };
}

/** Load all agent definitions for a workspace (built-ins + global + project). */
export async function resolveAgents(cwd: string): Promise<Map<string, AgentDefinition>> {
  const map = new Map<string, AgentDefinition>();
  for (const definition of BUILTIN_AGENTS) map.set(definition.name, definition);

  const globalDir = getPaths().globalAgentsDir;
  const projectDir = projectPaths(cwd).agentsDir;

  for (const dir of [globalDir, projectDir]) {
    let entries: string[] = [];
    try {
      const fs = await import("node:fs/promises");
      entries = await fs.readdir(dir);
    } catch {
      continue;
    }
    for (const entry of entries.sort()) {
      if (!entry.endsWith(".md")) continue;
      const filePath = path.join(dir, entry);
      const source = await readTextFile(filePath);
      if (!source) continue;
      const definition = agentFromMarkdown(filePath, source);
      if (definition) map.set(definition.name, definition); // later files override
    }
  }
  return map;
}

export function getAgent(agents: Map<string, AgentDefinition>, name: string): AgentDefinition | undefined {
  return agents.get(name.toLowerCase());
}

export function agentNames(agents: Map<string, AgentDefinition>): string[] {
  return [...agents.keys()].sort();
}

export async function findAgentFiles(cwd: string): Promise<string[]> {
  const found: string[] = [];
  const roots = [getPaths().globalAgentsDir, projectPaths(cwd).agentsDir];
  for (const root of roots) {
    try {
      for await (const entry of walk(root)) {
        if (!entry.dir && entry.relativePath.endsWith(".md")) found.push(entry.path);
      }
    } catch {
      /* missing dir */
    }
  }
  return found;
}
