import { chat } from "../ai/llm.js";
import type { ChatMessage } from "../ai/llm.js";

import logger from "../config/logger.config.js";
import AppError from "../services/AppError.js";

import {
  MAX_TASKS_PER_PLAN,
  addResult,
  failedTaskIds,
  nextPendingTask,
  reopenTasks,
  updateTask,
} from "./state.js";

import type {
  TeamRole,
  TeamTask,
  TaskStatus,
  WorkflowState,
} from "./state.js";

import {
  reviewDecisionSchema,
  taskAssignmentSchema,
} from "../validations/graph.validation.js";

import type { ReviewDecision } from "../validations/graph.validation.js";

/* =====================================================
   TYPES
===================================================== */

export type NodeFunction = (
  state: WorkflowState
) => Promise<Partial<WorkflowState>>;

/* =====================================================
   PROMPTS
===================================================== */

const PLANNING_SYSTEM = `
You are the tech-lead of an AI engineering team.
Break goals down into a concrete, ordered implementation plan.

Rules:
- Be specific: name modules, endpoints, data models and flows.
- Prefer a small number of high-leverage steps.
- Stay inside the scope of the goal.
- Reply with the plan only, in markdown.
`.trim();

const TEAM_ROLE_GUIDELINES = [
  "- tech-lead: coordination, sequencing, requirement clarity",
  "- architect: system design, boundaries, data flow",
  "- backend-engineer: APIs, services, data models, jobs",
  "- frontend-engineer: UI, state, client integration",
  "- ai-engineer: prompts, evals, RAG/LLM pipelines",
  "- qa-engineer: tests, edge cases, acceptance criteria",
  "- reviewer: gap and risk analysis",
  "- devops: CI/CD, deployment, observability",
].join("\n");

const ASSIGNMENT_SYSTEM = `
You are the tech-lead of an AI engineering team.
Split the approved plan into tasks and assign each task to the
single best role for it.

Available roles and what they own:
${TEAM_ROLE_GUIDELINES}

Reply with ONLY a JSON array (no prose, no markdown fences):
[
  {
    "title": "short task title",
    "description": "what to produce and the acceptance criteria",
    "role": "one of the available roles"
  }
]

Rules:
- Between 1 and ${MAX_TASKS_PER_PLAN} tasks.
- Order tasks so dependencies come first.
- Each description must be self-contained for the assigned role.
`.trim();

const REVIEWER_SYSTEM = `
You are the reviewer of an AI engineering team.
You judge whether the collected task results fully satisfy the goal.

Rules:
- Approve only when the results cover the whole plan with no blocking gaps.
- Never approve when some tasks failed.
- Call out concrete, actionable gaps instead of generic advice.

Reply with ONLY a JSON object (no prose, no markdown fences):
{
  "approved": true | false,
  "feedback": "what is missing or what looks good",
  "reworkTaskIds": ["ids of tasks that must be redone"]
}
`.trim();

const FINALIZER_SYSTEM = `
You are the tech-lead of an AI engineering team.
Combine the team results into one coherent final deliverable
for the original goal.

Rules:
- Merge the task results into a single answer, removing duplication.
- Keep working code, decisions and instructions intact.
- Reply with the deliverable only.
`.trim();

const ROLE_PROMPTS: Record<TeamRole, string> = {
  "tech-lead": `
You are the tech-lead. Clarify requirements, sequence the work and
decide what "done" means. Deliver crisp decisions and checklists.
`.trim(),

  architect: `
You are the architect. Produce the system design: components,
interfaces, data flow, technology choices and the trade-offs behind them.
`.trim(),

  "backend-engineer": `
You are the backend engineer. Deliver production-quality APIs,
services, data models and background jobs, including error handling
and the edge cases that bite in production.
`.trim(),

  "frontend-engineer": `
You are the frontend engineer. Deliver the UI structure, state
management and client-side integration details, including loading,
error and empty states.
`.trim(),

  "ai-engineer": `
You are the AI engineer. Deliver prompts, evaluation strategy and
LLM/RAG pipeline design with failure modes, cost and latency in mind.
`.trim(),

  "qa-engineer": `
You are the QA engineer. Deliver test strategy, concrete test cases,
edge cases and acceptance criteria that prove the goal is met.
`.trim(),

  reviewer: `
You are the reviewer. Point out gaps, risks and missing requirements
in the work produced so far.
`.trim(),

  devops: `
You are the DevOps engineer. Deliver deployment, CI/CD, environment
and observability details needed to ship and run this reliably.
`.trim(),
};

/* =====================================================
   PROMPT HELPERS
===================================================== */

const truncate = (value: string, max: number) =>
  value.length > max ? `${value.slice(0, max)}...` : value;

function buildPlanPrompt(state: WorkflowState): string {
  const context = state.messages.length
    ? `\n## Conversation context\n${state.messages
        .map((message) => `${message.role}: ${truncate(message.content, 500)}`)
        .join("\n")}\n`
    : "";

  return `## Goal\n${state.goal}${context}`;
}

function buildAssignmentPrompt(state: WorkflowState): string {
  return `## Goal\n${state.goal}\n\n## Plan\n${state.plan}`;
}

function buildContextBlock(state: WorkflowState): string {
  const sections: string[] = [];

  if (state.results.length) {
    sections.push(
      `## Team results so far\n${state.results
        .map(
          (result) =>
            `- [${result.role}] task ${result.taskId} (${result.ok ? "ok" : "failed"}): ` +
            truncate(result.output.replace(/\s+/g, " "), 400)
        )
        .join("\n")}`
    );
  }

  if (state.messages.length) {
    sections.push(
      `## Conversation context\n${state.messages
        .map((message) => `${message.role}: ${truncate(message.content, 500)}`)
        .join("\n")}`
    );
  }

  return sections.join("\n\n");
}

function buildExecutionMessages(
  state: WorkflowState,
  task: TeamTask
): ChatMessage[] {
  const system = [
    ROLE_PROMPTS[task.role],
    `## Goal\n${state.goal}`,
    state.plan ? `## Plan\n${state.plan}` : "",
    `## Your task: ${task.title}\n${task.description}`,
  ]
    .filter(Boolean)
    .join("\n\n");

  const context = buildContextBlock(state);

  const user = [
    context,
    "Complete your task as the assigned role. Reply with your " +
      "deliverable only, ready for another engineer to act on.",
  ]
    .filter(Boolean)
    .join("\n\n");

  return [
    { role: "system", content: system },
    { role: "user", content: user },
  ];
}

function buildReviewPrompt(state: WorkflowState): string {
  const results = state.results.length
    ? state.results
        .map(
          (result) =>
            `### Task ${result.taskId} — ${result.role}\n${truncate(result.output, 2500)}`
        )
        .join("\n\n")
    : "No results were produced.";

  return `## Goal\n${state.goal}\n\n## Plan\n${truncate(state.plan, 3000)}\n\n` +
    `## Results\n${results}\n\n## Iteration\n${state.iteration + 1} of ${state.maxIterations}`;
}

function buildFinalPrompt(state: WorkflowState): string {
  const results = state.results
    .filter((result) => result.ok)
    .map(
      (result) =>
        `### ${result.role} — task ${result.taskId}\n${truncate(result.output, 3000)}`
    )
    .join("\n\n");

  return `## Goal\n${state.goal}\n\n## Plan\n${truncate(state.plan, 3000)}\n\n` +
    `## Team results\n${results}`;
}

/* =====================================================
   OUTPUT PARSERS
===================================================== */

function parseTaskAssignment(raw: string): TeamTask[] | null {
  const match = raw.match(/\[[\s\S]*\]/);

  if (!match) {
    return null;
  }

  try {
    const result = taskAssignmentSchema.safeParse(
      JSON.parse(match[0])
    );

    if (!result.success) {
      return null;
    }

    return result.data.map((task, index) => ({
      id: `task-${index + 1}`,
      title: task.title,
      description: task.description,
      role: task.role,
      status: "pending" as TaskStatus,
    }));
  } catch {
    return null;
  }
}

function parseReviewDecision(
  raw: string,
  state: WorkflowState
): ReviewDecision {
  const match = raw.match(/\{[\s\S]*\}/);

  if (match) {
    try {
      const result = reviewDecisionSchema.safeParse(
        JSON.parse(match[0])
      );

      if (result.success) {
        return result.data;
      }
    } catch {
      // Fall through to the heuristic decision below.
    }
  }

  const approved = /^\s*(approved|lgtm|looks good)/i.test(raw);

  return {
    approved,
    feedback: truncate(raw, 2000),

    reworkTaskIds: approved
      ? []
      : state.tasks
          .filter((task) => task.status !== "done")
          .map((task) => task.id),
  };
}

/* =====================================================
   NODES
===================================================== */

export async function planNode(
  state: WorkflowState
): Promise<Partial<WorkflowState>> {
  if (state.plan) {
    return { status: "planning" };
  }

  const response = await chat(
    [
      { role: "system", content: PLANNING_SYSTEM },
      { role: "user", content: buildPlanPrompt(state) },
    ],
    { temperature: 0.2 }
  );

  const plan = response.content.trim();

  if (!plan) {
    throw new AppError(
      "Tech lead returned an empty plan",
      502
    );
  }

  logger.info("Graph node completed", {
    node: "plan",
    inputTokens: response.usage.inputTokens,
    outputTokens: response.usage.outputTokens,
  });

  return { plan, status: "planning" };
}

export async function assignNode(
  state: WorkflowState
): Promise<Partial<WorkflowState>> {
  if (state.tasks.length) {
    return { status: "assigning" };
  }

  const response = await chat(
    [
      { role: "system", content: ASSIGNMENT_SYSTEM },
      { role: "user", content: buildAssignmentPrompt(state) },
    ],
    { temperature: 0.1 }
  );

  let tasks = parseTaskAssignment(response.content);

  if (!tasks) {
    logger.warn("Tech lead returned malformed assignment, using fallback", {
      node: "assign",
    });

    tasks = [
      {
        id: "task-1",
        title: truncate(state.goal, 120),
        description: `Execute the plan:\n\n${state.plan}`,
        role: "tech-lead",
        status: "pending",
      },
    ];
  }

  const assigned = tasks.slice(0, MAX_TASKS_PER_PLAN);

  logger.info("Graph node completed", {
    node: "assign",
    taskCount: assigned.length,
  });

  return {
    tasks: assigned,
    currentRole: assigned[0].role,
    status: "assigning",
  };
}

export async function executeNode(
  state: WorkflowState
): Promise<Partial<WorkflowState>> {
  const task = nextPendingTask(state);

  if (!task) {
    return { status: "executing" };
  }

  const started = updateTask(state, task.id, {
    status: "in_progress",
  });

  try {
    const response = await chat(
      buildExecutionMessages(started, task),
      { temperature: 0.3 }
    );

    const output = response.content.trim();

    if (!output) {
      throw new AppError(
        `${task.role} returned an empty output`,
        502
      );
    }

    const recorded = addResult(started, {
      taskId: task.id,
      role: task.role,
      output,
      ok: true,
      createdAt: new Date().toISOString(),
    });

    const finished = updateTask(recorded, task.id, {
      status: "done",
    });

    logger.info("Graph node completed", {
      node: "execute",
      taskId: task.id,
      role: task.role,
      outputTokens: response.usage.outputTokens,
    });

    return {
      tasks: finished.tasks,
      results: finished.results,
      currentRole: task.role,
      status: "executing",
    };
  } catch (error) {
    const message =
      error instanceof Error ? error.message : String(error);

    logger.error("Graph task failed", {
      node: "execute",
      taskId: task.id,
      role: task.role,
      message,
    });

    const failed = updateTask(started, task.id, {
      status: "failed",
    });

    const recorded = addResult(failed, {
      taskId: task.id,
      role: task.role,
      output: `Task failed: ${message}`,
      ok: false,
      createdAt: new Date().toISOString(),
    });

    return {
      tasks: recorded.tasks,
      results: recorded.results,
      currentRole: task.role,
      status: "executing",
    };
  }
}

export async function reviewNode(
  state: WorkflowState
): Promise<Partial<WorkflowState>> {
  const iteration = state.iteration + 1;

  if (!state.results.length) {
    return {
      approved: false,
      reviewFeedback: "No results were produced to review.",
      iteration,
      status: "reviewing",
    };
  }

  const response = await chat(
    [
      { role: "system", content: REVIEWER_SYSTEM },
      { role: "user", content: buildReviewPrompt(state) },
    ],
    { temperature: 0.1 }
  );

  const decision = parseReviewDecision(response.content, state);

  let next = state;

  if (!decision.approved) {
    const rework = new Set([
      ...decision.reworkTaskIds,
      ...failedTaskIds(state),
    ]);

    // Everything still open counts as rework; when nothing is
    // open the reviewer wants the whole plan revisited.
    const ids = rework.size
      ? [...rework]
      : state.tasks.map((task) => task.id);

    next = reopenTasks(state, ids);
  }

  logger.info("Graph node completed", {
    node: "review",
    approved: decision.approved,
    iteration,
  });

  return {
    tasks: next.tasks,
    approved: decision.approved,
    reviewFeedback: decision.feedback,
    iteration,
    status: "reviewing",
  };
}

export async function finalizeNode(
  state: WorkflowState
): Promise<Partial<WorkflowState>> {
  const successful = state.results.filter(
    (result) => result.ok
  );

  if (!successful.length) {
    return {
      approved: false,

      finalOutput:
        "The team could not complete the goal: no task produced a " +
        "successful result. See results for the failure details.",

      status: "failed",
    };
  }

  try {
    const response = await chat(
      [
        { role: "system", content: FINALIZER_SYSTEM },
        { role: "user", content: buildFinalPrompt(state) },
      ],
      { temperature: 0.2 }
    );

    const finalOutput = response.content.trim();

    if (finalOutput) {
      logger.info("Graph node completed", {
        node: "finalize",
        outputTokens: response.usage.outputTokens,
      });

      return { finalOutput, status: "completed" };
    }
  } catch (error) {
    logger.warn("Finalizer fell back to a deterministic summary", {
      node: "finalize",

      message:
        error instanceof Error ? error.message : String(error),
    });
  }

  return {
    finalOutput: buildDeterministicSummary(state),
    status: "completed",
  };
}

function buildDeterministicSummary(
  state: WorkflowState
): string {
  const results = state.results
    .map(
      (result) =>
        `## ${result.role} — ${result.taskId}\n${result.output}`
    )
    .join("\n\n");

  return `# ${state.goal}\n\n${state.plan}\n\n${results}`;
}
