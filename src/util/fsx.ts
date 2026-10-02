/** Filesystem helpers: safe reads, atomic writes, recursive walks. */

import * as fs from "node:fs/promises";
import * as path from "node:path";

export async function pathExists(target: string): Promise<boolean> {
  try {
    await fs.access(target);
    return true;
  } catch {
    return false;
  }
}

export async function isDirectory(target: string): Promise<boolean> {
  try {
    const stat = await fs.stat(target);
    return stat.isDirectory();
  } catch {
    return false;
  }
}

export async function ensureDir(target: string): Promise<void> {
  await fs.mkdir(target, { recursive: true });
}

export async function readTextFile(target: string): Promise<string | null> {
  try {
    return await fs.readFile(target, "utf8");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
    throw error;
  }
}

export async function writeTextFileAtomic(target: string, contents: string): Promise<void> {
  await ensureDir(path.dirname(target));
  const tmp = `${target}.${process.pid}.${Date.now()}.tmp`;
  await fs.writeFile(tmp, contents, "utf8");
  await fs.rename(tmp, target);
}

/** Append a JSONL record to a file, creating parent directories as needed. */
export async function appendJsonLine(target: string, value: unknown): Promise<void> {
  await ensureDir(path.dirname(target));
  await fs.appendFile(target, `${JSON.stringify(value)}\n`, "utf8");
}

export interface WalkOptions {
  /** Directory names that are always skipped. */
  ignoreDirs?: string[];
  /** Skip files larger than this many bytes. */
  maxFileBytes?: number;
  /** Optional filter evaluated before descending into a directory. */
  skipDir?: (dirPath: string) => boolean;
}

const DEFAULT_IGNORE_DIRS = new Set([
  ".git",
  "node_modules",
  "dist",
  "build",
  "out",
  "coverage",
  ".next",
  ".cache",
  ".venv",
  "venv",
  "__pycache__",
  ".aet-cache",
]);

export interface WalkEntry {
  path: string;
  relativePath: string;
  size: number;
  dir: boolean;
}

/**
 * Recursively walk a directory tree yielding relative paths.
 * Yields directories first (so callers can prune), then files.
 */
export async function* walk(
  root: string,
  options: WalkOptions = {},
): AsyncGenerator<WalkEntry> {
  const ignore = new Set([...DEFAULT_IGNORE_DIRS, ...(options.ignoreDirs ?? [])]);
  const maxBytes = options.maxFileBytes ?? 4 * 1024 * 1024;
  const absoluteRoot = path.resolve(root);

  async function* visit(dir: string): AsyncGenerator<WalkEntry> {
    let entries: import("node:fs").Dirent[];
    try {
      entries = await fs.readdir(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const entry of entries) {
      const full = path.join(dir, entry.name);
      const relative = path.relative(absoluteRoot, full);
      if (entry.isDirectory()) {
        if (ignore.has(entry.name)) continue;
        if (options.skipDir?.(full)) continue;
        yield { path: full, relativePath: relative, size: 0, dir: true };
        yield* visit(full);
      } else if (entry.isFile() || entry.isSymbolicLink()) {
        let size = 0;
        try {
          size = (await fs.stat(full)).size;
        } catch {
          continue;
        }
        if (size > maxBytes) continue;
        yield { path: full, relativePath: relative, size, dir: false };
      }
    }
  }

  yield* visit(absoluteRoot);
}

/** Heuristic: does this buffer look like binary (non-text) content? */
export function looksBinary(buffer: Buffer): boolean {
  const sample = buffer.subarray(0, Math.min(buffer.length, 8000));
  for (const byte of sample) {
    if (byte === 0) return true;
  }
  return false;
}
