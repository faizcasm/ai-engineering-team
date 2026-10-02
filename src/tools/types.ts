/** Tool interfaces shared by built-in tools, MCP tools and the agent loop. */

import type { ToolSpec } from "../core/types.js";
import type { Config, PermissionMode } from "../core/config.js";
import type { PermissionGate, PermissionRequest, PermissionDecision } from "../core/permissions.js";

export interface ToolResult {
  /** Machine/model facing output. */
  output: string;
  /** Optional shorter human facing summary (defaults to output). */
  display?: string;
  isError?: boolean;
  meta?: Record<string, unknown>;
}

export type ToolEvent =
  | { type: "progress"; text: string }
  | { type: "background_started"; id: string; command: string }
  | { type: "todos"; todos: Todo[] }
  | { type: "log"; level: "debug" | "info" | "warn" | "error"; message: string };

export interface Todo {
  content: string;
  status: "pending" | "in_progress" | "completed";
  activeForm?: string;
}

/** Capabilities a tool may need from the running agent. */
export interface ToolHost {
  readonly cwd: string;
  readonly config: Config;
  readonly sessionId: string;
  readonly interactive: boolean;
  readonly agentName: string;
  readonly signal?: AbortSignal;
  /** Emit a UI event (progress lines, todo updates). */
  emit(event: ToolEvent): void;
  /** Route an interactive permission request (queued for subagents). */
  requestPermission(request: PermissionRequest): Promise<PermissionDecision>;
  /** Spawn an isolated subagent (the `Task` tool). */
  spawnSubagent(options: { type: string; prompt: string; model?: string; description: string }): Promise<string>;
  /** Render markdown/text produced by a tool for the terminal. */
  write(text: string): void;
}

export interface ToolContext extends ToolHost {
  permissionMode: PermissionMode;
}

export type { ToolSpec } from "../core/types.js";
export interface Tool {
  spec: ToolSpec;
  execute(input: unknown, ctx: ToolContext): Promise<ToolResult>;
}

/* ------------------------------------------------------------------------ */
/* Input validation helpers (small, dependency-free, good error messages)    */
/* ------------------------------------------------------------------------ */

export function asObject(input: unknown): Record<string, unknown> {
  if (input === null || typeof input !== "object" || Array.isArray(input)) {
    throw new ToolInputError(`expected an object input, got ${describe(input)}`);
  }
  return input as Record<string, unknown>;
}

export function requireString(obj: Record<string, unknown>, key: string): string {
  const value = obj[key];
  if (typeof value !== "string" || value.length === 0) {
    throw new ToolInputError(`"${key}" is required and must be a non-empty string`);
  }
  return value;
}

export function optionalString(obj: Record<string, unknown>, key: string): string | undefined {
  const value = obj[key];
  if (value === undefined || value === null) return undefined;
  if (typeof value !== "string") throw new ToolInputError(`"${key}" must be a string`);
  return value;
}

export function optionalNumber(obj: Record<string, unknown>, key: string): number | undefined {
  const value = obj[key];
  if (value === undefined || value === null) return undefined;
  if (typeof value !== "number" || Number.isNaN(value)) throw new ToolInputError(`"${key}" must be a number`);
  return value;
}

export function optionalBoolean(obj: Record<string, unknown>, key: string): boolean | undefined {
  const value = obj[key];
  if (value === undefined || value === null) return undefined;
  if (typeof value !== "boolean") throw new ToolInputError(`"${key}" must be a boolean`);
  return value;
}

export function describe(value: unknown): string {
  if (value === null) return "null";
  if (Array.isArray(value)) return "array";
  return typeof value;
}

export class ToolInputError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ToolInputError";
  }
}

/** Guard used by tools that must not escape the workspace without approval. */
export function ensureNotTooLarge(text: string, max: number, label: string): string {
  if (text.length <= max) return text;
  return `${text.slice(0, max)}\n\u2026 [truncated ${label}: ${text.length - max} more chars]`;
}
