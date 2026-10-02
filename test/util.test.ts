/**
 * Pure utility helpers: text, glob matching, diffs.
 *
 * Author: Faizan Hameed (https://faizcasm.me) - Founder of Ryuksaidso
 */

import { test } from "node:test";
import assert from "node:assert/strict";

import {
  truncateEnd,
  truncateMiddle,
  matchGlob,
  humanDuration,
  humanBytes,
  shellQuote,
  splitList,
  wrap,
  randomId,
  plural,
} from "../src/util/text.js";
import { diffLines, formatDiff, summarizeDiff } from "../src/util/diff.js";

test("truncateEnd keeps the head of long paths", () => {
  assert.equal(truncateEnd("abcdefghij", 5), "abcd…");
  assert.equal(truncateEnd("abc", 10), "abc");
});

test("truncateMiddle keeps both ends", () => {
  assert.equal(truncateMiddle("abcdefghij", 5), "ab…ij");
});

test("matchGlob handles * and ** and character classes", () => {
  assert.equal(matchGlob("src/*.ts", "src/a.ts"), true);
  assert.equal(matchGlob("src/*.ts", "src/nested/a.ts"), false);
  assert.equal(matchGlob("src/**/*.ts", "src/nested/a.ts"), true);
  assert.equal(matchGlob("**/*.md", "docs/readme.md"), true);
  assert.equal(matchGlob("*.ts", "a.js"), false);
  assert.equal(matchGlob("a?.ts", "ab.ts"), true);
});

test("humanDuration and humanBytes render compact units", () => {
  assert.match(humanDuration(500), /500ms|0s/);
  assert.match(humanDuration(65_000), /1m/);
  assert.match(humanBytes(2048), /2(\.\d+)? KB/);
  assert.match(humanBytes(5 * 1024 * 1024), /5(\.\d+)? MB/);
});

test("shellQuote single-quotes arguments safely", () => {
  assert.equal(shellQuote("simple"), "'simple'");
  assert.equal(shellQuote("has space"), "'has space'");
  assert.equal(shellQuote("it's"), "'it'\\''s'");
});

test("splitList trims and drops empties", () => {
  assert.deepEqual(splitList(" a , b ,,c "), ["a", "b", "c"]);
  assert.deepEqual(splitList(undefined), []);
});

test("wrap breaks long lines at word boundaries", () => {
  const lines = wrap("the quick brown fox jumps over the lazy dog", 12);
  assert.ok(lines.length > 1);
  assert.ok(lines.every((line) => line.length <= 12));
  assert.equal(lines.join(" ").replace(/\s+/g, " ").trim(), "the quick brown fox jumps over the lazy dog");
});

test("randomId is the requested length and unique enough", () => {
  const a = randomId(8);
  const b = randomId(8);
  assert.equal(a.length, 8);
  assert.notEqual(a, b);
});

test("plural picks the right form", () => {
  assert.equal(plural(1, "turn"), "turn");
  assert.equal(plural(3, "turn"), "turns");
  assert.equal(plural(0, "task", "tasks"), "tasks");
});

test("diffLines reports added, removed and context", () => {
  const diff = diffLines("a\nb\nc\n", "a\nx\nc\n");
  const stats = summarizeDiff(diff);
  assert.equal(stats.added, 1);
  assert.equal(stats.removed, 1);
  assert.ok(diff.some((line) => line.op === "context"));
});

test("formatDiff renders a unified-style block", () => {
  const output = formatDiff(diffLines("a\nb\n", "a\nb\nc\n"), { colorize: false });
  assert.match(output, /\+ c/);
  assert.match(output, /^--- before/m);
  assert.match(output, /^\+\+\+ after/m);
});

test("formatDiff reports when nothing changed", () => {
  const output = formatDiff(diffLines("a\nb\n", "a\nb\n"), { colorize: false });
  assert.match(output, /no content changes/);
});
