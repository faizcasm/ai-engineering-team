/** Lightweight terminal Markdown renderer (no dependencies). */

import { style } from "../util/color.js";
import { wrap } from "../util/text.js";

export interface RenderOptions {
  width?: number;
  color?: boolean;
  /** Prefix applied to every output line (e.g. "  "). */
  prefix?: string;
  /** Compact mode used for tool output. */
  compact?: boolean;
}

function resolveWidth(width?: number): number {
  const columns = process.stdout.columns || 100;
  return Math.max(40, Math.min(width ?? columns, 160));
}

function inline(text: string, color: boolean): string {
  if (!color) return text.replace(/\*\*([^*]+)\*\*/g, "$1").replace(/`([^`]+)`/g, "$1").replace(/\*([^*]+)\*/g, "$1");
  return text
    .replace(/`([^`]+)`/g, (_m, code: string) => style.yellow(code))
    .replace(/\*\*([^*]+)\*\*/g, (_m, bold: string) => style.bold(bold))
    .replace(/(^|[^*])\*([^*\n]+)\*/g, (_m, pre: string, italic: string) => `${pre}${style.italic(italic)}`)
    .replace(/\[([^\]]+)\]\(([^)]+)\)/g, (_m, label: string, url: string) => `${style.underline(label)} ${style.dim(`(${url})`)}`);
}

/** Render markdown text for the terminal. */
export function renderMarkdown(text: string, options: RenderOptions = {}): string {
  const width = resolveWidth(options.width);
  const color = options.color ?? true;
  const prefix = options.prefix ?? "";
  const lines: string[] = [];
  const input = text.replace(/\r\n/g, "\n").split("\n");

  let inCode = false;
  let codeLang = "";
  let codeBuffer: string[] = [];

  const flushCode = (): void => {
    if (codeBuffer.length === 0) {
      lines.push(`${prefix}${color ? style.dim("\u250c\u2500 code") : "\u250c\u2500 code"}`);
      lines.push(`${prefix}${color ? style.dim("\u2502") : "\u2502"} (empty)`);
      lines.push(`${prefix}${color ? style.dim("\u2514\u2500\u2500") : "\u2514\u2500\u2500"}`);
      codeBuffer = [];
      return;
    }
    const label = codeLang || "code";
    const inner = Math.max(20, width - 4);
    lines.push(`${prefix}${color ? style.dim(`\u250c\u2500 ${label}`) : `\u250c\u2500 ${label}`}`);
    for (const raw of codeBuffer) {
      const chunks = raw.length > inner ? raw.match(new RegExp(`.{1,${inner}}`, "g")) ?? [""] : [raw];
      for (const chunk of chunks) {
        lines.push(`${prefix}${color ? style.dim("\u2502 ") : "\u2502 "}${color ? style.white(chunk) : chunk}`);
      }
    }
    lines.push(`${prefix}${color ? style.dim("\u2514\u2500\u2500") : "\u2514\u2500\u2500"}`);
    codeBuffer = [];
  };

  for (const line of input) {
    const fence = /^```(\w*)\s*$/.exec(line.trimEnd());
    if (fence) {
      if (inCode) {
        flushCode();
        inCode = false;
        codeLang = "";
      } else {
        inCode = true;
        codeLang = fence[1] ?? "";
      }
      continue;
    }
    if (inCode) {
      codeBuffer.push(line);
      continue;
    }

    const trimmed = line.trimEnd();
    if (trimmed.length === 0) {
      lines.push("");
      continue;
    }

    // Headings
    const heading = /^(#{1,6})\s+(.*)$/.exec(trimmed);
    if (heading) {
      const level = heading[1]!.length;
      const content = heading[2]!;
      const rendered = color
        ? level <= 2
          ? style.bold(style.cyan(content))
          : style.bold(style.white(content))
        : content;
      lines.push(`${prefix}${rendered}`);
      continue;
    }

    // Horizontal rule
    if (/^(-{3,}|\*{3,}|_{3,})$/.test(trimmed)) {
      lines.push(`${prefix}${color ? style.dim("\u2500".repeat(Math.min(width - prefix.length, 60))) : "\u2500".repeat(60)}`);
      continue;
    }

    // Blockquote
    if (trimmed.startsWith("> ")) {
      const body = trimmed.slice(2);
      for (const wrapped of wrap(inline(body, color), width - prefix.length - 2)) {
        lines.push(`${prefix}${color ? style.dim("\u2502 ") : "\u2502 "}${wrapped}`);
      }
      continue;
    }

    // Lists
    const bullet = /^(\s*)([-*+]|\d+[.)])\s+(.*)$/.exec(trimmed);
    if (bullet) {
      const indentWidth = Math.min((bullet[1] ?? "").length, 8);
      const marker = bullet[2]!;
      const content = bullet[3]!;
      const renderedMarker = /^\d/.test(marker) ? `${marker} ` : color ? style.green("\u2022 ") : "\u2022 ";
      const hanging = " ".repeat(indentWidth + 2);
      const body = inline(content, color);
      const wrapped = wrap(body, width - prefix.length - indentWidth - 2);
      wrapped.forEach((chunk, index) => {
        if (index === 0) {
          lines.push(`${prefix}${" ".repeat(indentWidth)}${renderedMarker}${chunk}`);
        } else {
          lines.push(`${prefix}${hanging}${chunk}`);
        }
      });
      continue;
    }

    // Table
    if (trimmed.startsWith("|")) {
      lines.push(`${prefix}${color ? style.dim(trimmed) : trimmed}`);
      continue;
    }

    const wrapped = wrap(inline(trimmed, color), width - prefix.length);
    for (const chunk of wrapped) lines.push(`${prefix}${chunk}`);
  }

  if (inCode) flushCode();

  return lines.join("\n");
}

/** Render plain (non-markdown) text with wrapping only. */
export function renderText(text: string, options: RenderOptions = {}): string {
  const width = resolveWidth(options.width);
  const prefix = options.prefix ?? "";
  return text
    .split("\n")
    .flatMap((line) => (line.length === 0 ? [""] : wrap(line, width - prefix.length)))
    .map((line) => `${prefix}${line}`)
    .join("\n");
}
