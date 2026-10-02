/** TodoWrite: persistent task list shown in the REPL status area. */

import type { Tool, ToolResult, Todo } from "./types.js";
import { asObject, ToolInputError } from "./types.js";

const STATUSES = new Set(["pending", "in_progress", "completed"]);

export const todoTool: Tool = {
  spec: {
    name: "TodoWrite",
    description:
      "Maintain a structured task list for the current session. Call this at the start of a multi-step job and " +
      "update it as you progress (exactly one in_progress item, all finished items completed).",
    inputSchema: {
      type: "object",
      properties: {
        todos: {
          type: "array",
          description: "The full desired task list (replaces the previous one)",
          items: {
            type: "object",
            properties: {
              content: { type: "string", description: "Task description" },
              status: { type: "string", enum: ["pending", "in_progress", "completed"] },
              activeForm: { type: "string", description: "Present-continuous form shown while running" },
            },
            required: ["content", "status"],
            additionalProperties: false,
          },
        },
      },
      required: ["todos"],
      additionalProperties: false,
    },
  },
  async execute(rawInput, ctx): Promise<ToolResult> {
    const input = asObject(rawInput);
    const raw = input.todos;
    if (!Array.isArray(raw)) throw new ToolInputError('"todos" must be an array');

    const todos: Todo[] = raw.map((entry, index) => {
      const item = entry as Record<string, unknown>;
      const content = item.content;
      const status = item.status;
      if (typeof content !== "string" || content.length === 0) {
        throw new ToolInputError(`todos[${index}].content must be a non-empty string`);
      }
      if (typeof status !== "string" || !STATUSES.has(status)) {
        throw new ToolInputError(`todos[${index}].status must be pending, in_progress or completed`);
      }
      const activeForm = typeof item.activeForm === "string" ? item.activeForm : undefined;
      return { content, status: status as Todo["status"], ...(activeForm ? { activeForm } : {}) };
    });

    const inProgress = todos.filter((todo) => todo.status === "in_progress");
    if (inProgress.length > 1) {
      throw new ToolInputError("only one todo may be in_progress at a time");
    }

    ctx.emit({ type: "todos", todos });

    const lines = todos.map((todo) => {
      const mark = todo.status === "completed" ? "x" : todo.status === "in_progress" ? ">" : " ";
      return `[${mark}] ${todo.content}`;
    });
    return {
      output: `Updated todos:\n${lines.join("\n")}`,
      display: `${todos.filter((t) => t.status === "completed").length}/${todos.length} completed`,
      meta: { todos },
    };
  },
};
