import type { ChatMessage } from "../ai/llm.js";

/* =====================================================
   TEAM ROLES
===================================================== */

export const TEAM_ROLES = [
  "tech-lead",
  "architect",
  "backend-engineer",
  "frontend-engineer",
  "ai-engineer",
  "qa-engineer",
  "reviewer",
  "devops",
] as const;

export type TeamRole = (typeof TEAM_ROLES)[number];

export const ROLE_DESCRIPTIONS: Record<TeamRole, string> = {
  "tech-lead":
    "Breaks the goal into tasks, sequences the work and coordinates the team.",

  architect:
    "Designs the system shape: boundaries, data flow, technology choices.",

  "backend-engineer":
    "Implements APIs, services, data models and background jobs.",

  "frontend-engineer":
    "Implements user-facing UI, state management and client integrations.",

  "ai-engineer":
    "Designs prompts, evaluations and LLM/RAG pipelines.",

  "qa-engineer":
    "Defines test strategy, edge cases and acceptance criteria.",

  reviewer:
    "Reviews the team output for gaps, risks and missing requirements.",

  devops:
    "Handles deployment, CI/CD, observability and infrastructure concerns.",
};

export function isTeamRole(
  value: unknown
): value is TeamRole {
  return (
    typeof value === "string" &&
    (TEAM_ROLES as readonly string[]).includes(value)
  );
}

/* =====================================================
   STATE TYPES
===================================================== */

export type TaskStatus =
  | "pending"
  | "in_progress"
  | "done"
  | "failed";

export interface TeamTask {
  id: string;
  title: string;
  description: string;
  role: TeamRole;
  status: TaskStatus;
}

export interface TaskResult {
  taskId: string;
  role: TeamRole;
  output: string;
  ok: boolean;
  createdAt: string;
}

export type WorkflowStatus =
  | "idle"
  | "planning"
  | "assigning"
  | "executing"
  | "reviewing"
  | "finalizing"
  | "completed"
  | "failed"
  | "max_iterations";

export interface WorkflowState {
  goal: string;
  plan: string;
  tasks: TeamTask[];
  results: TaskResult[];
  messages: ChatMessage[];
  currentRole: TeamRole | null;
  iteration: number;
  maxIterations: number;
  status: WorkflowStatus;
  approved: boolean;
  reviewFeedback: string;
  finalOutput: string;
}

export interface WorkflowInput {
  goal: string;
  maxIterations?: number;
  messages?: ChatMessage[];
}

/* =====================================================
   CONSTANTS
===================================================== */

export const DEFAULT_MAX_ITERATIONS = 3;

export const MAX_TASKS_PER_PLAN = 12;

/* =====================================================
   REDUCERS
===================================================== */

export function createInitialState(
  input: WorkflowInput
): WorkflowState {
  return {
    goal: input.goal.trim(),
    plan: "",
    tasks: [],
    results: [],
    messages: input.messages ?? [],
    currentRole: null,
    iteration: 0,

    maxIterations: Math.max(
      1,
      Math.min(
        input.maxIterations ?? DEFAULT_MAX_ITERATIONS,
        10
      )
    ),

    status: "idle",
    approved: false,
    reviewFeedback: "",
    finalOutput: "",
  };
}

export function mergeState(
  current: WorkflowState,
  partial: Partial<WorkflowState>
): WorkflowState {
  return { ...current, ...partial };
}

export function setStatus(
  state: WorkflowState,
  status: WorkflowStatus
): WorkflowState {
  return { ...state, status };
}

export function addTasks(
  state: WorkflowState,
  tasks: TeamTask[]
): WorkflowState {
  return { ...state, tasks: [...state.tasks, ...tasks] };
}

export function addResult(
  state: WorkflowState,
  result: TaskResult
): WorkflowState {
  return { ...state, results: [...state.results, result] };
}

export function updateTask(
  state: WorkflowState,
  taskId: string,
  patch: Partial<TeamTask>
): WorkflowState {
  return {
    ...state,

    tasks: state.tasks.map((task) =>
      task.id === taskId
        ? { ...task, ...patch, id: task.id }
        : task
    ),
  };
}

export function reopenTasks(
  state: WorkflowState,
  taskIds: string[]
): WorkflowState {
  const ids = new Set(taskIds);

  return {
    ...state,

    tasks: state.tasks.map((task) =>
      ids.has(task.id)
        ? { ...task, status: "pending" as TaskStatus }
        : task
    ),
  };
}

export function appendMessage(
  state: WorkflowState,
  message: ChatMessage
): WorkflowState {
  return { ...state, messages: [...state.messages, message] };
}

export function pendingTasks(
  state: WorkflowState
): TeamTask[] {
  return state.tasks.filter(
    (task) => task.status !== "done"
  );
}

export function nextPendingTask(
  state: WorkflowState
): TeamTask | null {
  return (
    state.tasks.find(
      (task) => task.status === "pending"
    ) || null
  );
}

export function failedTaskIds(
  state: WorkflowState
): string[] {
  return state.tasks
    .filter((task) => task.status === "failed")
    .map((task) => task.id);
}
