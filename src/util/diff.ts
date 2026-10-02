/** Minimal line diff (LCS) used by Write/Edit to show what changed. */

import { style } from "./color.js";

export type DiffOp = "add" | "del" | "context";

export interface DiffLine {
  op: DiffOp;
  text: string;
  left?: number;
  right?: number;
}

const MAX_DP_CELLS = 4_000_000; // ~3000x1300 lines - above this we fall back.

export function diffLines(leftText: string, rightText: string): DiffLine[] {
  const left = leftText.length === 0 ? [] : leftText.replace(/\n$/, "").split("\n");
  const right = rightText.length === 0 ? [] : rightText.replace(/\n$/, "").split("\n");

  if (left.length * right.length > MAX_DP_CELLS) {
    return [
      ...left.map((text, index) => ({ op: "del" as const, text, left: index + 1 })),
      ...right.map((text, index) => ({ op: "add" as const, text, right: index + 1 })),
    ];
  }

  // LCS dynamic programming table.
  const table: number[][] = Array.from({ length: left.length + 1 }, () => new Array<number>(right.length + 1).fill(0));
  for (let i = left.length - 1; i >= 0; i -= 1) {
    for (let j = right.length - 1; j >= 0; j -= 1) {
      table[i]![j] = left[i] === right[j] ? table[i + 1]![j + 1]! + 1 : Math.max(table[i + 1]![j]!, table[i]![j + 1]!);
    }
  }

  const out: DiffLine[] = [];
  let i = 0;
  let j = 0;
  while (i < left.length && j < right.length) {
    if (left[i] === right[j]) {
      out.push({ op: "context", text: left[i]!, left: i + 1, right: j + 1 });
      i += 1;
      j += 1;
    } else if (table[i + 1]![j]! >= table[i]![j + 1]!) {
      out.push({ op: "del", text: left[i]!, left: i + 1 });
      i += 1;
    } else {
      out.push({ op: "add", text: right[j]!, right: j + 1 });
      j += 1;
    }
  }
  while (i < left.length) {
    out.push({ op: "del", text: left[i]!, left: i + 1 });
    i += 1;
  }
  while (j < right.length) {
    out.push({ op: "add", text: right[j]!, right: j + 1 });
    j += 1;
  }
  return out;
}

export interface FormatDiffOptions {
  contextLines?: number;
  maxLines?: number;
  colorize?: boolean;
  leftLabel?: string;
  rightLabel?: string;
}

export function formatDiff(diff: DiffLine[], options: FormatDiffOptions = {}): string {
  const contextLines = options.contextLines ?? 2;
  const maxLines = options.maxLines ?? 60;
  const colorize = options.colorize ?? true;

  // Trim context far from changes.
  const keep = new Array<boolean>(diff.length).fill(false);
  for (let index = 0; index < diff.length; index += 1) {
    if (diff[index]!.op !== "context") {
      for (let k = Math.max(0, index - contextLines); k <= Math.min(diff.length - 1, index + contextLines); k += 1) {
        keep[k] = true;
      }
    }
  }

  const lines: string[] = [];
  const header = `--- ${options.leftLabel ?? "before"}\n+++ ${options.rightLabel ?? "after"}`;
  if (diff.every((line) => line.op === "context")) {
    return `${header}\n(no content changes)`;
  }
  lines.push(header);
  let skipped = 0;
  let printed = 0;

  for (let index = 0; index < diff.length; index += 1) {
    if (!keep[index]) {
      skipped += 1;
      continue;
    }
    if (skipped > 0) {
      lines.push(colorize ? style.muted(`\u22ee ${skipped} unchanged line${skipped === 1 ? "" : "s"}`) : `\u22ee ${skipped}`);
      skipped = 0;
    }
    if (printed >= maxLines) {
      lines.push(colorize ? style.muted("\u22ee diff truncated") : "\u22ee diff truncated");
      break;
    }
    const line = diff[index]!;
    const raw = `${line.op === "add" ? "+" : line.op === "del" ? "-" : " "} ${line.text}`;
    if (!colorize) {
      lines.push(raw);
    } else if (line.op === "add") {
      lines.push(style.green(raw));
    } else if (line.op === "del") {
      lines.push(style.red(raw));
    } else {
      lines.push(style.gray(raw));
    }
    printed += 1;
  }
  return lines.join("\n");
}

export function summarizeDiff(diff: DiffLine[]): { added: number; removed: number } {
  let added = 0;
  let removed = 0;
  for (const line of diff) {
    if (line.op === "add") added += 1;
    else if (line.op === "del") removed += 1;
  }
  return { added, removed };
}
