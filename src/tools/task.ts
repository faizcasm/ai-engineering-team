/** Task: delegate work to an isolated subagent from the AI engineering team. */

import type { Tool, ToolResult } from "./types.js";
import { asObject, requireString, optionalString, ToolInputError } from "./types.js";

export const taskTool: Tool = {
  spec: {
    name: "Task",
    description:
      "Delegate a self-contained chunk of work to a specialist subagent (fresh context, its own tool loop). " +
      "Returns the subagent's final report. Use for parallelizable or context-heavy work: research, implementing a " +
      "module, writing tests, reviewing a diff. subagent_type must be a known team role.",
    inputSchema: {
      type: "object",
      properties: {
        description: { type: "string", description: "3-5 word summary of the task" },
        prompt: { type: "string", description: "Complete instructions for the subagent - include paths, constraints and the expected output format" },
        subagent_type: { type: "string", description: "Team role, e.g. backend-engineer, frontend-engineer, qa-engineer, reviewer, researcher" },
        model: { type: "string", description: "Optional model override for the subagent" },
      },
      required: ["description", "prompt", "subagent_type"],
      additionalProperties: false,
    },
  },
  async execute(rawInput, ctx): Promise<ToolResult> {
    const input = asObject(rawInput);
    const description = requireString(input, "description");
    const prompt = requireString(input, "prompt");
    const subagentType = requireString(input, "subagent_type");
    const model = optionalString(input, "model");

    if (prompt.length < 10) {
      throw new ToolInputError('"prompt" is too short - give the subagent full context and expectations');
    }

    ctx.emit({ type: "progress", text: `${subagentType}: ${description}` });

    try {
      const report = await ctx.spawnSubagent({
        type: subagentType,
        prompt,
        description,
        ...(model ? { model } : {}),
      });
      return {
        output: `Subagent "${subagentType}" (${description}) finished:\n\n${report}`,
        display: `${subagentType} \u00b7 ${description}`,
        meta: { subagentType },
      };
    } catch (error) {
      return { output: `Subagent "${subagentType}" failed: ${(error as Error).message}`, isError: true };
    }
  },
};
