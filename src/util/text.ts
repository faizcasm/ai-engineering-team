/** String helpers used across the CLI (wrapping, truncation, matching). */

import { stripAnsi } from "./color.js";

export function truncateEnd(text: string, max: number): string {
  if (text.length <= max) return text;
  if (max <= 1) return text.slice(0, max);
  return `${text.slice(0, max - 1)}\u2026`;
}

export function truncateMiddle(text: string, max: number): string {
  if (text.length <= max) return text;
  const half = Math.floor((max - 1) / 2);
  return `${text.slice(0, half)}\u2026${text.slice(text.length - half)}`;
}

/** Word-wrap text at `width` columns, preserving ANSI sequences. */
export function wrap(text: string, width: number): string[] {
  const lines: string[] = [];
  for (const raw of text.split("\n")) {
    if (stripAnsi(raw).length <= width) {
      lines.push(raw);
      continue;
    }
    let current = "";
    let currentWidth = 0;
    const tokens = raw.split(/(\s+)/);
    for (const token of tokens) {
      const tokenWidth = stripAnsi(token).length;
      if (currentWidth + tokenWidth > width && current.trim().length > 0) {
        lines.push(current);
        current = "";
        currentWidth = 0;
      }
      if (tokenWidth > width) {
        // Hard-break very long tokens (e.g. URLs, paths).
        for (const ch of token) {
          if (currentWidth >= width) {
            lines.push(current);
            current = "";
            currentWidth = 0;
          }
          current += ch;
          currentWidth += 1;
        }
      } else {
        current += token;
        currentWidth += tokenWidth;
      }
    }
    if (current.trim().length > 0 || raw.trim().length === 0) lines.push(current);
  }
  return lines;
}

export function indent(text: string, prefix: string): string {
  return text
    .split("\n")
    .map((line) => (line.length > 0 ? prefix + line : line))
    .join("\n");
}

export function countLines(text: string): number {
  if (text.length === 0) return 0;
  return text.split("\n").length;
}

export function plural(count: number, one: string, many?: string): string {
  return count === 1 ? one : many ?? `${one}s`;
}

export function humanBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  if (bytes < 1024 * 1024 * 1024) return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
  return `${(bytes / (1024 * 1024 * 1024)).toFixed(1)} GB`;
}

export function humanDuration(ms: number): string {
  if (ms < 1000) return `${Math.round(ms)}ms`;
  if (ms < 60_000) return `${(ms / 1000).toFixed(1)}s`;
  const minutes = Math.floor(ms / 60_000);
  const seconds = Math.round((ms % 60_000) / 1000);
  return `${minutes}m ${seconds}s`;
}

/** Match a string against a simple glob (`*`, `?`, `**`). */
export function globToRegExp(pattern: string, caseSensitive = true): RegExp {
  let out = "";
  for (let i = 0; i < pattern.length; i += 1) {
    const ch = pattern[i]!;
    if (ch === "*") {
      if (pattern[i + 1] === "*") {
        // `**/` matches any number of directories, `**` matches anything.
        if (pattern[i + 2] === "/") {
          out += "(?:[^/]*\\/)*";
          i += 2;
        } else {
          out += ".*";
          i += 1;
        }
      } else {
        out += "[^/]*";
      }
    } else if (ch === "?") {
      out += "[^/]";
    } else if (ch === "{") {
      const close = pattern.indexOf("}", i);
      if (close > i) {
        const alternatives = pattern.slice(i + 1, close).split(",");
        out += `(?:${alternatives.map((a) => a.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")).join("|")})`;
        i = close;
        continue;
      }
      out += "\\{";
    } else if ("+.^$()|[]\\".includes(ch)) {
      out += `\\${ch}`;
    } else {
      out += ch;
    }
  }
  return new RegExp(`^${out}$`, caseSensitive ? "" : "i");
}

export function matchGlob(pattern: string, value: string, caseSensitive = true): boolean {
  return globToRegExp(pattern, caseSensitive).test(value);
}

/** Escape a string for safe inclusion inside a bash single-quoted string. */
export function shellQuote(value: string): string {
  return `'${value.replace(/'/g, `'\\''`)}'`;
}

export function randomId(length = 8): string {
  const alphabet = "abcdefghijklmnopqrstuvwxyz0123456789";
  let out = "";
  for (let i = 0; i < length; i += 1) {
    out += alphabet[Math.floor(Math.random() * alphabet.length)];
  }
  return out;
}

/** Parse an optional `key=value` style list, e.g. "a,b,c" or "a,b". */
export function splitList(value: string | undefined): string[] {
  if (!value) return [];
  return value
    .split(",")
    .map((part) => part.trim())
    .filter((part) => part.length > 0);
}
