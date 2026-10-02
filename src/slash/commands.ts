/** Custom slash commands loaded from `.aet/commands/*.md` and `~/.aet/commands/*.md`. */

import * as path from "node:path";
import { readTextFile, walk } from "../util/fsx.js";
import { getPaths, projectPaths } from "../core/paths.js";
import { parseFrontmatter } from "../team/agents.js";

export interface CustomCommand {
  name: string;
  description: string;
  /** Prompt template; `$ARGUMENTS` / `{{args}}` are replaced with the user's text. */
  body: string;
  model?: string;
  agent?: string;
  allowedTools?: string[];
  /** Files referenced with `@path` are inlined before sending. */
  source: string;
}

async function loadFromDir(dir: string, cwd: string): Promise<CustomCommand[]> {
  const results: CustomCommand[] = [];
  let entries: string[] = [];
  try {
    const fs = await import("node:fs/promises");
    entries = await fs.readdir(dir);
  } catch {
    return results;
  }
  for (const entry of entries.sort()) {
    if (!entry.endsWith(".md")) continue;
    const filePath = path.join(dir, entry);
    const source = await readTextFile(filePath);
    if (!source) continue;
    const { attributes, body } = parseFrontmatter(source);
    const name = (attributes.name ?? path.basename(entry, ".md")).toLowerCase();
    if (!body.trim()) continue;
    results.push({
      name,
      description: attributes.description ?? body.split("\n")[0]!.slice(0, 100),
      body,
      source: filePath,
      ...(attributes.model ? { model: attributes.model } : {}),
      ...(attributes.agent || attributes.agent ? { agent: attributes.agent } : {}),
      ...(attributes.model ? { model: attributes.model } : {}),
      ...(attributes.agent ? { agent: attributes.agent } : {}),
      ...(attributes.allowedTools ?? attributes.allowed_tools ?? attributes["allowed-tools"]
        ? {
            allowedTools: (attributes.allowedTools ?? attributes.allowed_tools ?? attributes["allowed-tools"] ?? "")
              .split(",")
              .map((tool) => tool.trim())
              .filter(Boolean),
          }
        : {}),
    });
  }
  void cwd;
  return results;
}

export async function loadCustomCommands(cwd: string): Promise<Map<string, CustomCommand>> {
  const map = new Map<string, CustomCommand>();
  for (const dir of [getPaths().globalCommandsDir, projectPaths(cwd).commandsDir]) {
    for (const command of await loadFromDir(dir, cwd)) {
      map.set(command.name, command);
    }
  }
  return map;
}

/** Replace `$ARGUMENTS` / `{{args}}` placeholders. */
export function expandCommand(template: string, args: string): string {
  const trimmed = args.trim();
  return template
    .replace(/\$ARGUMENTS/g, trimmed)
    .replace(/\{\{\s*args\s*\}\}/g, trimmed)
    .replace(/\{\{\s*arg\s*\}\}/g, trimmed);
}

/** Inline `@relative/path` references with file contents (max 50k chars each). */
export async function expandFileReferences(text: string, cwd: string): Promise<string> {
  const matches = [...text.matchAll(/@([A-Za-z0-9_\-./]+\.[A-Za-z0-9]+)/g)];
  if (matches.length === 0) return text;

  let result = text;
  for (const match of matches) {
    const reference = match[1]!;
    const filePath = path.isAbsolute(reference) ? reference : path.resolve(cwd, reference);
    const contents = await readTextFile(filePath);
    if (contents === null) continue;
    const block = `\`\`\`${path.extname(filePath).slice(1)} ${reference}\n${contents.slice(0, 50_000)}\n\`\`\``;
    result = result.replace(`@${reference}`, block);
  }
  return result;
}

export async function findCommandFiles(cwd: string): Promise<string[]> {
  const found: string[] = [];
  for (const root of [getPaths().globalCommandsDir, projectPaths(cwd).commandsDir]) {
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
