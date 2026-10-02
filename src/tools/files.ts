/** File-reading and file-writing tools: Read, Write, Edit, MultiEdit. */

import * as fs from "node:fs/promises";
import * as path from "node:path";
import { diffLines, formatDiff, summarizeDiff } from "../util/diff.js";
import { looksBinary, pathExists, readTextFile, ensureDir } from "../util/fsx.js";
import { humanBytes } from "../util/text.js";
import { resolveWorkspacePath } from "./bash.js";
import type { Tool, ToolResult } from "./types.js";
import {
  asObject,
  optionalBoolean,
  optionalNumber,
  requireString,
  ToolInputError,
} from "./types.js";

const DEFAULT_LIMIT = 2000;

function formatNumbered(lines: string[], startLine: number, includeEnd?: number): string {
  const last = includeEnd ?? startLine + lines.length - 1;
  const width = String(last).length;
  return lines
    .map((line, index) => `${String(startLine + index).padStart(width)}\u2192 ${line}`)
    .join("\n");
}

export const readTool: Tool = {
  spec: {
    name: "Read",
    description:
      "Read a text file from disk. Returns numbered lines (`N-> content`). Use offset/limit for large files. " +
      "Always prefer this over shell cat so line numbers can be referenced in edits.",
    inputSchema: {
      type: "object",
      properties: {
        file_path: { type: "string", description: "Absolute or workspace-relative path" },
        offset: { type: "number", description: "1-based line to start from (default 1)" },
        limit: { type: "number", description: `Maximum lines to read (default ${DEFAULT_LIMIT})` },
      },
      required: ["file_path"],
      additionalProperties: false,
    },
  },
  async execute(rawInput, ctx): Promise<ToolResult> {
    const input = asObject(rawInput);
    const filePath = resolveWorkspacePath(requireString(input, "file_path"), ctx.cwd);
    const offset = optionalNumber(input, "offset") ?? 1;
    const limit = optionalNumber(input, "limit") ?? DEFAULT_LIMIT;

    if (offset < 1) throw new ToolInputError('"offset" must be >= 1');
    if (limit < 1) throw new ToolInputError('"limit" must be >= 1');

    if (!(await pathExists(filePath))) {
      return { output: `File not found: ${filePath}`, isError: true };
    }
    const stat = await fs.stat(filePath);
    if (stat.isDirectory()) {
      const entries = await fs.readdir(filePath);
      return {
        output: `${filePath} is a directory with ${entries.length} entries:\n${entries.slice(0, 100).join("\n")}`,
        display: `directory ${path.relative(ctx.cwd, filePath) || filePath}`,
      };
    }

    const buffer = await fs.readFile(filePath);
    if (looksBinary(buffer)) {
      return {
        output: `Binary file (${humanBytes(stat.size)}): ${filePath}. Binary content is not readable; inspect it with shell tools if needed.`,
        display: `binary ${path.relative(ctx.cwd, filePath) || filePath}`,
      };
    }

    const contents = buffer.toString("utf8");
    if (contents.length === 0) {
      return { output: `(file is empty: ${filePath})`, display: `0 lines \u00b7 ${path.relative(ctx.cwd, filePath) || filePath}` };
    }

    const allLines = contents.split("\n");
    if (allLines[allLines.length - 1] === "") allLines.pop();
    const total = allLines.length;

    if (offset > total) {
      return { output: `offset ${offset} is past the end of ${filePath} (${total} lines)`, isError: true };
    }

    const slice = allLines.slice(offset - 1, offset - 1 + limit);
    const truncated = slice.length < allLines.slice(offset - 1).length;
    const body = formatNumbered(slice, offset, total);
    const header = `# ${path.relative(ctx.cwd, filePath) || filePath} (${total} lines${offset > 1 || limit < total ? `, showing ${offset}-${offset + slice.length - 1}` : ""})`;
    const output = truncated ? `${header}\n${body}\n\u2026 [file continues - re-read with offset ${offset + slice.length}]` : `${header}\n${body}`;
    return {
      output,
      display: `${slice.length} lines \u00b7 ${path.relative(ctx.cwd, filePath) || filePath}`,
      meta: { totalLines: total, startLine: offset },
    };
  },
};

export const writeTool: Tool = {
  spec: {
    name: "Write",
    description:
      "Create or overwrite a file with the given content. Creates parent directories. Shows a diff of what changed.",
    inputSchema: {
      type: "object",
      properties: {
        file_path: { type: "string", description: "Absolute or workspace-relative path" },
        content: { type: "string", description: "Full file content" },
      },
      required: ["file_path", "content"],
      additionalProperties: false,
    },
  },
  async execute(rawInput, ctx): Promise<ToolResult> {
    const input = asObject(rawInput);
    const filePath = resolveWorkspacePath(requireString(input, "file_path"), ctx.cwd);
    const content = requireString(input, "content");

    const before = await readTextFile(filePath);
    const existed = before !== null;

    if (existed && before === content) {
      return { output: `No changes: ${filePath} already has this exact content.`, display: `unchanged ${path.relative(ctx.cwd, filePath) || filePath}` };
    }

    await ensureDir(path.dirname(filePath));
    await fs.writeFile(filePath, content, "utf8");

    const diff = diffLines(before ?? "", content);
    const { added, removed } = summarizeDiff(diff);
    const lines = content.length === 0 ? 0 : content.split("\n").length;
    const relative = path.relative(ctx.cwd, filePath) || filePath;
    const verb = existed ? "Updated" : "Created";

    return {
      output: `${verb} ${relative} (${lines} lines, +${added} -${removed})\n${formatDiff(diff, { leftLabel: existed ? relative : "/dev/null", rightLabel: relative, colorize: false })}`,
      display: `${verb} ${relative} (+${added} -${removed})`,
      meta: { path: filePath, added, removed, created: !existed },
    };
  },
};

interface EditSpec {
  old_string: string;
  new_string: string;
  replace_all?: boolean;
}

function applyEdit(contents: string, spec: EditSpec, filePath: string): { next: string; occurrences: number } {
  const { old_string: oldString, new_string: newString, replace_all: replaceAll } = spec;
  if (typeof oldString !== "string" || oldString.length === 0) {
    throw new ToolInputError('"old_string" is required and must be a non-empty string');
  }
  if (typeof newString !== "string") {
    throw new ToolInputError('"new_string" must be a string (use "" to delete)');
  }
  if (oldString === newString) {
    throw new ToolInputError('"old_string" and "new_string" are identical');
  }

  let occurrences = 0;
  let searchFrom = 0;
  while (true) {
    const index = contents.indexOf(oldString, searchFrom);
    if (index === -1) break;
    occurrences += 1;
    searchFrom = index + Math.max(1, oldString.length);
  }

  if (occurrences === 0) {
    const nearMiss = contents.includes(oldString.trim().split("\n")[0] ?? "");
    throw new ToolInputError(
      `old_string not found in ${path.basename(filePath)}` +
        (nearMiss ? " (a similar fragment exists - check whitespace/indentation exactly)" : "") +
        ". Read the file first and copy the text verbatim.",
    );
  }
  if (occurrences > 1 && !replaceAll) {
    throw new ToolInputError(
      `old_string matches ${occurrences} times in ${path.basename(filePath)}. ` +
        `Add surrounding context to make it unique, or set replace_all: true.`,
    );
  }

  const next = replaceAll ? contents.split(oldString).join(newString) : contents.replace(oldString, newString);
  return { next, occurrences };
}

export const editTool: Tool = {
  spec: {
    name: "Edit",
    description:
      "Replace an exact string in an existing file. old_string must match exactly once (or set replace_all). " +
      "Read the file first and copy old_string verbatim, including indentation.",
    inputSchema: {
      type: "object",
      properties: {
        file_path: { type: "string", description: "Absolute or workspace-relative path" },
        old_string: { type: "string", description: "Exact text to replace (must be unique unless replace_all)" },
        new_string: { type: "string", description: "Replacement text" },
        replace_all: { type: "boolean", description: "Replace every occurrence" },
      },
      required: ["file_path", "old_string", "new_string"],
      additionalProperties: false,
    },
  },
  async execute(rawInput, ctx): Promise<ToolResult> {
    const input = asObject(rawInput);
    const filePath = resolveWorkspacePath(requireString(input, "file_path"), ctx.cwd);
    const spec: EditSpec = {
      old_string: requireString(input, "old_string"),
      new_string: typeof input.new_string === "string" ? input.new_string : (() => { throw new ToolInputError('"new_string" must be a string'); })(),
      replace_all: optionalBoolean(input, "replace_all"),
    };

    const before = await readTextFile(filePath);
    if (before === null) {
      return { output: `File not found: ${filePath}. Use Write to create it.`, isError: true };
    }

    const { next, occurrences } = applyEdit(before, spec, filePath);
    await fs.writeFile(filePath, next, "utf8");

    const diff = diffLines(before, next);
    const { added, removed } = summarizeDiff(diff);
    const relative = path.relative(ctx.cwd, filePath) || filePath;
    return {
      output: `Edited ${relative} (+${added} -${removed}, ${occurrences} occurrence${occurrences === 1 ? "" : "s"} replaced)\n${formatDiff(diff, { leftLabel: relative, rightLabel: relative, colorize: false })}`,
      display: `edited ${relative} (+${added} -${removed})`,
      meta: { path: filePath, added, removed, occurrences },
    };
  },
};

export const multiEditTool: Tool = {
  spec: {
    name: "MultiEdit",
    description: "Apply several edits to one file in a single call. Each edit must match exactly once.",
    inputSchema: {
      type: "object",
      properties: {
        file_path: { type: "string", description: "Absolute or workspace-relative path" },
        edits: {
          type: "array",
          description: "Edits applied in order",
          items: {
            type: "object",
            properties: {
              old_string: { type: "string" },
              new_string: { type: "string" },
              replace_all: { type: "boolean" },
            },
            required: ["old_string", "new_string"],
            additionalProperties: false,
          },
        },
      },
      required: ["file_path", "edits"],
      additionalProperties: false,
    },
  },
  async execute(rawInput, ctx): Promise<ToolResult> {
    const input = asObject(rawInput);
    const filePath = resolveWorkspacePath(requireString(input, "file_path"), ctx.cwd);
    const editsRaw = input.edits;
    if (!Array.isArray(editsRaw) || editsRaw.length === 0) {
      throw new ToolInputError('"edits" must be a non-empty array');
    }

    const before = await readTextFile(filePath);
    if (before === null) return { output: `File not found: ${filePath}`, isError: true };

    let current = before;
    let totalAdded = 0;
    let totalRemoved = 0;
    for (const [index, rawEdit] of editsRaw.entries()) {
      const edit = rawEdit as EditSpec;
      try {
        const { next } = applyEdit(current, { ...edit, old_string: edit.old_string ?? "" }, filePath);
        const delta = summarizeDiff(diffLines(current, next));
        totalAdded += delta.added;
        totalRemoved += delta.removed;
        current = next;
      } catch (error) {
        throw new ToolInputError(`edit #${index + 1}: ${(error as Error).message}`);
      }
    }
    await fs.writeFile(filePath, current, "utf8");
    const relative = path.relative(ctx.cwd, filePath) || filePath;
    return {
      output: `Applied ${editsRaw.length} edits to ${relative} (+${totalAdded} -${totalRemoved})`,
      display: `edited ${relative} x${editsRaw.length} (+${totalAdded} -${totalRemoved})`,
      meta: { path: filePath, added: totalAdded, removed: totalRemoved, edits: editsRaw.length },
    };
  },
};
