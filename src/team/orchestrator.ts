/**
 * Team pipeline: plan -> delegate -> review.
 *
 * A tech-lead model decomposes the goal into tasks and assigns team roles,
 * specialists execute (bounded parallelism, dependency aware) and a reviewer
 * agent inspects the combined result.
 */

import type { Config } from "../core/config.js";
import type { AgentDefinition } from "./agents.js";
import type { Provider } from "../core/types.js";
import type { PermissionGate } from "../core/permissions.js";
import type { Session } from "../core/session.js";
import type { Tool } from "../tools/types.js";
import { Agent, type AgentEvents } from "../core/agent.js";
import { costUsd } from "../providers/models.js";
import { humanDuration } from "../util/text.js";
import { getAgent } from "./agents.js";

export interface TeamTask {
  id: string;
  title: string;
  description: string;
  role: string;
  dependsOn: string[];
}

export interface TeamPlan {
  summary: string;
  tasks: TeamTask[];
}

export interface TeamTaskResult extends TeamTask {
  output: string;
  ok: boolean;
  durationMs: number;
}

export interface TeamReport {
  goal: string;
  plan: TeamPlan;
  tasks: TeamTaskResult[];
  review?: string;
  durationMs: number;
  costUsd: number;
  stopReason: "end_turn" | "error" | "aborted";
}

export interface TeamRunOptions {
  goal: string;
  cwd: string;
  config: Config;
  provider: Provider;
  providerId: string;
  model: string;
  agents: Map<string, AgentDefinition>;
  tools: Tool[];
  session?: Session;
  gate?: PermissionGate;
  interactive: boolean;
  events?: AgentEvents;
  signal?: AbortSignal;
  maxParallel?: number;
  planOnly?: boolean;
  appendSystemPrompt?: string;
}

const PLAN_SYSTEM = `You are the tech lead of an AI engineering team operating in a real codebase.
Break the user's goal into the smallest set of independent tasks that together achieve it.

Respond with ONLY a JSON object (no markdown fences, no commentary) of the shape:
{
  "summary": "one paragraph describing the approach",
  "tasks": [
    {
      "id": "1",
      "title": "short title",
      "description": "complete self-contained instructions for the specialist, including file paths you expect them to touch and how to verify the work",
      "role": "one of: tech-lead, architect, backend-engineer, frontend-engineer, ai-engineer, qa-engineer, reviewer, devops-engineer, researcher, documentation-engineer, general",
      "dependsOn": []
    }
  ]
}

Rules:
- 1 to 8 tasks. Prefer 3-5.
- Tasks that share files must be sequenced via dependsOn; truly independent work must NOT depend on each other.
- Each description must be executable by a fresh engineer with no prior context: name the files, the expected behaviour and the verification step.
- Assign the narrowest role that fits.`;

export function extractJson(text: string): unknown {
  const fenced = /```(?:json)?\s*([\s\S]*?)```/.exec(text);
  const candidate = fenced?.[1] ?? text;
  const start = candidate.indexOf("{");
  const end = candidate.lastIndexOf("}");
  if (start === -1 || end === -1) throw new Error("no JSON object found in model output");
  return JSON.parse(candidate.slice(start, end + 1));
}

export function parsePlan(raw: string, agents: Map<string, AgentDefinition>): TeamPlan {
  const parsed = extractJson(raw) as { summary?: string; tasks?: unknown };
  if (!Array.isArray(parsed.tasks)) throw new Error("plan is missing a `tasks` array");
  const tasks: TeamTask[] = [];
  const seen = new Set<string>();

  parsed.tasks.forEach((entry, index) => {
    const task = entry as Record<string, unknown>;
    const id = String(task.id ?? index + 1);
    const title = String(task.title ?? `Task ${id}`);
    const description = String(task.description ?? "");
    if (!description) return;
    const requestedRole = String(task.role ?? "general").toLowerCase();
    const role = getAgent(agents, requestedRole)?.name ?? "general";
    const dependsOn = Array.isArray(task.dependsOn) ? task.dependsOn.map((value) => String(value)) : [];
    seen.add(id);
    tasks.push({ id, title, description, role, dependsOn });
  });

  if (tasks.length === 0) throw new Error("plan contained no executable tasks");
  // Drop dangling dependencies.
  for (const task of tasks) task.dependsOn = task.dependsOn.filter((dep) => seen.has(dep) && dep !== task.id);

  return { summary: String(parsed.summary ?? ""), tasks };
}

/** Execute tasks respecting dependencies with bounded parallelism. */
async function executeTasks(
  plan: TeamPlan,
  options: TeamRunOptions,
  onTaskStart: (task: TeamTask) => void,
): Promise<TeamTaskResult[]> {
  const maxParallel = Math.max(1, options.maxParallel ?? 3);
  const results = new Map<string, TeamTaskResult>();
  const pending = new Set(plan.tasks.map((task) => task.id));
  const inFlight = new Map<string, Promise<void>>();
  const aborted = (): boolean => options.signal?.aborted ?? false;

  const isReady = (task: TeamTask): boolean => task.dependsOn.every((dep) => results.has(dep));

  const launch = (task: TeamTask): Promise<void> => {
    onTaskStart(task);
    const definition = options.agents.get(task.role) ?? options.agents.get("general")!;
    const priorContext = task.dependsOn
      .map((dep) => results.get(dep))
      .filter((result): result is TeamTaskResult => Boolean(result?.ok))
      .map((result) => `### Completed task ${result.id}: ${result.title}\n${result.output}`)
      .join("\n\n");

    const agent = new Agent({
      agentDef: definition,
      cwd: options.cwd,
      config: options.config,
      provider: options.provider,
      providerId: options.providerId,
      model: definition.model ?? options.model,
      tools: options.tools,
      agents: options.agents,
      ...(options.session ? { session: options.session } : {}),
      ...(options.gate ? { gate: options.gate } : {}),
      interactive: options.interactive,
      ...(options.signal ? { signal: options.signal } : {}),
      events: options.events,
    });

    const startedAt = Date.now();
    const prompt =
      `You are working as part of a coordinated AI engineering team.\n\n` +
      `Team goal: ${options.goal}\n` +
      (plan.summary ? `Tech lead's approach: ${plan.summary}\n` : "") +
      (priorContext ? `\nUpstream work already completed:\n${priorContext}\n` : "") +
      `\n## Your task ${task.id}: ${task.title}\n${task.description}\n\n` +
      `Do the work in the workspace, verify it, then reply with a short report: what you changed (file paths), why, how you verified it, and anything the next task must know.`;

    const promise = agent
      .run(prompt)
      .then((result) => {
        results.set(task.id, {
          ...task,
          output: result.text || "(no output)",
          ok: result.stopReason !== "error" && result.stopReason !== "aborted",
          durationMs: Date.now() - startedAt,
        });
      })
      .catch((error: unknown) => {
        results.set(task.id, {
          ...task,
          output: `Task failed: ${(error as Error).message}`,
          ok: false,
          durationMs: Date.now() - startedAt,
        });
      })
      .finally(() => {
        pending.delete(task.id);
        inFlight.delete(task.id);
      });
    inFlight.set(task.id, promise);
    return promise;
  };

  while (pending.size > 0 && !aborted()) {
    const ready = plan.tasks.filter((task) => pending.has(task.id) && isReady(task) && !inFlight.has(task.id));
    if (ready.length === 0 && inFlight.size === 0) {
      // Dependency deadlock (shouldn't happen after validation) - run the rest as-is.
      for (const id of pending) {
        const task = plan.tasks.find((entry) => entry.id === id)!;
        task.dependsOn = [];
      }
      continue;
    }
    const slots = maxParallel - inFlight.size;
    for (const task of ready.slice(0, slots)) {
      void launch(task);
    }
    if (inFlight.size > 0) {
      await Promise.race([...inFlight.values()]);
    } else {
      await new Promise((resolve) => setTimeout(resolve, 25));
    }
  }

  await Promise.allSettled([...inFlight.values()]);
  return plan.tasks.map((task) => results.get(task.id) ?? { ...task, output: "(not run)", ok: false, durationMs: 0 });
}

export async function runTeam(options: TeamRunOptions): Promise<TeamReport> {
  const startedAt = Date.now();
  options.events?.onLog?.("info", "tech-lead: planning\u2026");

  const planResult = await options.provider.complete({
    system: PLAN_SYSTEM,
    messages: [{ role: "user", content: [{ type: "text", text: `Goal: ${options.goal}` }] }],
    tools: [],
    model: options.model,
    maxTokens: Math.min(4000, options.config.maxTokens),
    ...(options.signal ? { signal: options.signal } : {}),
  });

  const planText = planResult.message.content
    .map((block) => (block.type === "text" ? block.text : ""))
    .filter(Boolean)
    .join("");

  let plan: TeamPlan;
  try {
    plan = parsePlan(planText, options.agents);
  } catch (error) {
    return {
      goal: options.goal,
      plan: { summary: planText.slice(0, 500), tasks: [] },
      tasks: [],
      durationMs: Date.now() - startedAt,
      costUsd: costUsd(options.model, options.providerId, planResult.usage),
      stopReason: "error",
    };
  }

  options.events?.onLog?.("info", `plan: ${plan.tasks.length} task(s) - ${plan.summary}`);
  const cost = costUsd(options.model, options.providerId, planResult.usage);

  if (options.planOnly) {
    return {
      goal: options.goal,
      plan,
      tasks: [],
      durationMs: Date.now() - startedAt,
      costUsd: cost,
      stopReason: "end_turn",
    };
  }

  const tasks = await executeTasks(plan, options, (task) => {
    options.events?.onLog?.("info", `\u2192 ${task.role}: ${task.title}`);
  });

  for (const task of tasks) {
    options.events?.onLog?.(task.ok ? "info" : "error", `\u2713 ${task.role}: ${task.title} (${humanDuration(task.durationMs)})`);
  }

  if (options.signal?.aborted) {
    return {
      goal: options.goal,
      plan,
      tasks,
      durationMs: Date.now() - startedAt,
      costUsd: cost,
      stopReason: "aborted",
    };
  }

  // Review ------------------------------------------------------------------
  options.events?.onLog?.("info", "reviewer: inspecting the work\u2026");
  const reviewerDef = options.agents.get("reviewer") ?? options.agents.get("general")!;
  const reviewer = new Agent({
    agentDef: reviewerDef,
    cwd: options.cwd,
    config: options.config,
    provider: options.provider,
    providerId: options.providerId,
    model: options.model,
    tools: options.tools,
    agents: options.agents,
    ...(options.gate ? { gate: options.gate } : {}),
    interactive: options.interactive,
    ...(options.signal ? { signal: options.signal } : {}),
    events: options.events,
  });

  const reviewInput =
    `The team executed the following plan for the goal:\n\n${options.goal}\n\n` +
    `Plan summary: ${plan.summary}\n\n` +
    tasks
      .map((task) => `### Task ${task.id} (${task.role}, ${task.ok ? "ok" : "FAILED"}): ${task.title}\n${task.output.slice(0, 6000)}`)
      .join("\n\n") +
    `\n\nInspect the actual changes in the workspace (git diff, modified files) and give the final report:\n` +
    `1. Verdict (what is done and working)\n2. What remains / risks\n3. Concrete follow-ups, ordered by priority.\n` +
    `Be terse and factual.`;

  const review = await reviewer.run(reviewInput);
  const totalCost = cost + review.costUsd;

  return {
    goal: options.goal,
    plan,
    tasks,
    review: review.text,
    durationMs: Date.now() - startedAt,
    costUsd: totalCost,
    stopReason: "end_turn",
  };
}

/** Render a team report as markdown. */
export function formatTeamReport(report: TeamReport): string {
  const lines: string[] = [];
  lines.push(`# Team report: ${report.goal}`);
  lines.push("");
  if (report.plan.summary) lines.push(`**Approach:** ${report.plan.summary}`, "");
  lines.push(`## Tasks`);
  for (const task of report.tasks) {
    const mark = task.ok ? "\u2705" : "\u274C";
    lines.push(`- ${mark} **${task.title}** \`${task.role}\` (${humanDuration(task.durationMs)})`);
    const firstLine = task.output.split("\n").find((line) => line.trim().length > 0) ?? "";
    if (firstLine) lines.push(`  ${firstLine.slice(0, 200)}`);
  }
  if (report.review) {
    lines.push("", `## Review`, "", report.review);
  }
  lines.push("", `\u2014 completed in ${humanDuration(report.durationMs)}`);
  return lines.join("\n");
}
