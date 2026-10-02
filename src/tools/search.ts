/** Search tools: Glob (file finding), Grep (content search), LS (directory listing). */

import * as fs from "node:fs/promises";
import * as path from "node:path";
import { isDirectory, pathExists, walk, looksBinary, readTextFile } from "../util/fsx.js";
import { matchGlob, truncateEnd } from "../util/text.js";
import { resolveWorkspacePath } from "./bash.js";
import type { Tool, ToolResult } from "./types.js";
import { asObject, optionalBoolean, optionalNumber, optionalString, requireString, ToolInputError } from "./types.js";

const DEFAULT_HEAD_LIMIT = 100;

export const globTool: Tool = {
  spec: {
    name: "Glob",
    description:
      "Find files by glob pattern, e.g. `src/**/*.ts` or `**/*.test.{js,ts}`. Supports `*`, `**`, `?` and `{a,b}`. " +
      "Returns paths sorted by modification time (newest first).",
    inputSchema: {
      type: "object",
      properties: {
        pattern: { type: "string", description: "Glob pattern" },
        path: { type: "string", description: "Directory to search from (default: workspace root)" },
        limit: { type: "number", description: `Max results (default 200)` },
        modified_desc: { type: "boolean", description: "Sort newest first (default true)" },
      },
      required: ["pattern"],
      additionalProperties: false,
    },
  },
  async execute(rawInput, ctx): Promise<ToolResult> {
    const input = asObject(rawInput);
    const pattern = requireString(input, "pattern");
    const root = resolveWorkspacePath(optionalString(input, "path") ?? ctx.cwd, ctx.cwd);
    const limit = optionalNumber(input, "limit") ?? 200;
    const newestFirst = optionalBoolean(input, "modified_desc") ?? true;

    if (!(await isDirectory(root))) {
      return { output: `Not a directory: ${root}`, isError: true };
    }

    const hasSlash = pattern.includes("/");
    const matches: Array<{ relative: string; full: string; mtime: number }> = [];

    for await (const entry of walk(root)) {
      if (entry.dir) continue;
      const relative = entry.relativePath;
      const matched = hasSlash
        ? matchGlob(pattern, relative) || matchGlob(pattern.startsWith("**/") ? pattern : `**/${pattern}`, relative)
        : matchGlob(pattern, path.basename(relative)) || matchGlob(pattern, relative);
      if (!matched) continue;
      let mtime = 0;
      try {
        mtime = (await fs.stat(entry.path)).mtimeMs;
      } catch {
        mtime = 0;
      }
      matches.push({ relative, full: entry.path, mtime });
      if (matches.length > limit * 4) break;
    }

    matches.sort((a, b) => (newestFirst ? b.mtime - a.mtime : a.relative.localeCompare(b.relative)));
    const top = matches.slice(0, limit);
    if (top.length === 0) {
      return { output: `No files matched "${pattern}" under ${path.relative(ctx.cwd, root) || "."}`, display: "0 matches" };
    }
    const body = top.map((entry) => entry.full).join("\n");
    return {
      output: `${top.length} match(es):\n${body}${matches.length > top.length ? `\n\u2026 ${matches.length - top.length} more` : ""}`,
      display: `${top.length} file${top.length === 1 ? "" : "s"}`,
      meta: { count: top.length },
    };
  },
};

interface GrepOptions {
  pattern: string;
  root: string;
  glob?: string;
  ignoreCase: boolean;
  multiline: boolean;
  mode: "content" | "files_with_matches" | "count";
  headLimit: number;
}

async function grepSearch(options: GrepOptions): Promise<{ lines: string[]; filesScanned: number; truncated: boolean }> {
  let regex: RegExp;
  try {
    regex = new RegExp(options.pattern, `${options.ignoreCase ? "i" : ""}${options.multiline ? "ms" : "m"}`);
  } catch (error) {
    throw new ToolInputError(`invalid regular expression: ${(error as Error).message}`);
  }

  const lines: string[] = [];
  let filesScanned = 0;
  let truncated = false;

  const targets: string[] = [];
  if (await isDirectory(options.root)) {
    for await (const entry of walk(options.root)) {
      if (entry.dir) continue;
      if (options.glob && !matchGlob(options.glob, entry.relativePath) && !matchGlob(options.glob, path.basename(entry.relativePath))) continue;
      targets.push(entry.path);
    }
  } else {
    targets.push(options.root);
  }

  for (const target of targets) {
    if (truncated) break;
    let contents: string | null;
    try {
      const buffer = await fs.readFile(target);
      if (looksBinary(buffer)) continue;
      contents = buffer.toString("utf8");
    } catch {
      continue;
    }
    filesScanned += 1;
    const relative = path.relative(options.root, target) || path.basename(target);

    if (options.mode === "files_with_matches") {
      if (regex.test(contents)) {
        lines.push(target);
        if (lines.length >= options.headLimit) truncated = true;
      }
      continue;
    }
    if (options.mode === "count") {
      const count = contents.match(new RegExp(regex.source, `${options.ignoreCase ? "i" : ""}${options.multiline ? "g" : "gm"}`))?.length ?? 0;
      if (count > 0) lines.push(`${relative}: ${count}`);
      continue;
    }

    const fileLines = contents.split("\n");
    for (let index = 0; index < fileLines.length; index += 1) {
      const line = fileLines[index]!;
      if (regex.test(line)) {
        lines.push(`${relative}:${index + 1}:${truncateEnd(line.trimEnd(), 400)}`);
        if (lines.length >= options.headLimit) {
          truncated = true;
          break;
        }
      }
      if (options.multiline) regex.lastIndex = 0;
    }
  }

  return { lines, filesScanned, truncated };
}

export const grepTool: Tool = {
  spec: {
    name: "Grep",
    description:
      "Search file contents with a regular expression. Returns `path:line:content`. " +
      "Supports output_mode content | files_with_matches | count and a glob filter.",
    inputSchema: {
      type: "object",
      properties: {
        pattern: { type: "string", description: "Regular expression to search for" },
        path: { type: "string", description: "File or directory to search (default: workspace root)" },
        glob: { type: "string", description: "Filter files by glob, e.g. `*.ts`" },
        ignore_case: { type: "boolean", description: "Case insensitive search" },
        multiline: { type: "boolean", description: "Match across lines (`.` matches newlines)" },
        output_mode: { type: "string", enum: ["content", "files_with_matches", "count"], description: "Default: content" },
        head_limit: { type: "number", description: `Max results (default ${DEFAULT_HEAD_LIMIT})` },
      },
      required: ["pattern"],
      additionalProperties: false,
    },
  },
  async execute(rawInput, ctx): Promise<ToolResult> {
    const input = asObject(rawInput);
    const pattern = requireString(input, "pattern");
    const root = resolveWorkspacePath(optionalString(input, "path") ?? ctx.cwd, ctx.cwd);
    const modeRaw = optionalString(input, "output_mode") ?? "content";
    if (!["content", "files_with_matches", "count"].includes(modeRaw)) {
      throw new ToolInputError('"output_mode" must be content, files_with_matches or count');
    }

    if (!(await pathExists(root))) {
      return { output: `Path not found: ${root}`, isError: true };
    }

    const result = await grepSearch({
      pattern,
      root,
      glob: optionalString(input, "glob"),
      ignoreCase: optionalBoolean(input, "ignore_case") ?? false,
      multiline: optionalBoolean(input, "multiline") ?? false,
      mode: modeRaw as GrepOptions["mode"],
      headLimit: optionalNumber(input, "head_limit") ?? DEFAULT_HEAD_LIMIT,
    });

    if (result.lines.length === 0) {
      return { output: `No matches for /${pattern}/ in ${path.relative(ctx.cwd, root) || "."} (${result.filesScanned} files scanned)`, display: "0 matches" };
    }
    const suffix = result.truncated ? `\n\u2026 results truncated (head_limit reached)` : "";
    return {
      output: `${result.lines.join("\n")}${suffix}`,
      display: `${result.lines.length} match${result.lines.length === 1 ? "" : "es"} in ${result.filesScanned} files`,
      meta: { matches: result.lines.length, truncated: result.truncated },
    };
  },
};

export const lsTool: Tool = {
  spec: {
    name: "LS",
    description: "List directory contents (directories first). Non-recursive; use Glob for recursive searches.",
    inputSchema: {
      type: "object",
      properties: {
        path: { type: "string", description: "Directory to list (default: workspace root)" },
        ignore: { type: "array", items: { type: "string" }, description: "Entry names to hide" },
      },
      additionalProperties: false,
    },
  },
  async execute(rawInput, ctx): Promise<ToolResult> {
    const input = asObject(rawInput);
    const target = resolveWorkspacePath(optionalString(input, "path") ?? ctx.cwd, ctx.cwd);
    const ignore = new Set(Array.isArray(input.ignore) ? (input.ignore as string[]) : []);

    if (!(await pathExists(target))) return { output: `Not found: ${target}`, isError: true };
    if (!(await isDirectory(target))) return { output: `Not a directory: ${target}`, isError: true };

    const entries = await fs.readdir(target, { withFileTypes: true });
    const visible = entries.filter((entry) => !ignore.has(entry.name) && !entry.name.startsWith(".git"));
    const dirs = visible.filter((entry) => entry.isDirectory()).map((entry) => `${entry.name}/`);
    const files = visible.filter((entry) => !entry.isDirectory()).map((entry) => entry.name);
    const sorted = [...dirs.sort(), ...files.sort()];
    const relative = path.relative(ctx.cwd, target) || target;
    if (sorted.length === 0) return { output: `${relative} is empty`, display: `${relative} (empty)` };
    return { output: `${relative}/\n${sorted.join("\n")}`, display: `${sorted.length} entries in ${relative}` };
  },
};

/** Read a file as an escape hatch for the model (used by @file expansion). */
export async function readAnyFile(filePath: string): Promise<string | null> {
  return readTextFile(filePath);
}
