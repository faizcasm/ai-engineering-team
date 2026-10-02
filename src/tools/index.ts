/** Built-in tool registry. */

import type { Tool, ToolSpec } from "./types.js";
import { bashTool, bashOutputTool, killShellTool } from "./bash.js";
import { readTool, writeTool, editTool, multiEditTool } from "./files.js";
import { globTool, grepTool, lsTool } from "./search.js";
import { todoTool } from "./todo.js";
import { webFetchTool } from "./webfetch.js";
import { taskTool } from "./task.js";

export function builtinTools(): Tool[] {
  return [
    readTool,
    writeTool,
    editTool,
    multiEditTool,
    globTool,
    grepTool,
    lsTool,
    bashTool,
    bashOutputTool,
    killShellTool,
    webFetchTool,
    todoTool,
    taskTool,
  ];
}

export function toSpecs(tools: Tool[]): ToolSpec[] {
  return tools.map((tool) => tool.spec);
}

export function findTool(tools: Tool[], name: string): Tool | undefined {
  return tools.find((tool) => tool.spec.name === name);
}

export { type Tool, type ToolResult, type ToolContext, type ToolHost, type Todo } from "./types.js";
