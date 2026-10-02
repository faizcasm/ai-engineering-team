/**
 * CLI argument parsing.
 *
 * Author: Faizan Hameed (https://faizcasm.me) - Founder of Ryuksaidso
 */

import { test } from "node:test";
import assert from "node:assert/strict";

import { parseArgs, splitAtCommand, optionBool, optionString, optionNumber } from "../src/cli/args.js";
import { GLOBAL_OPTIONS, COMMAND_OPTIONS } from "../src/cli/help.js";

test("parses global flags and positionals", () => {
  const args = parseArgs(["--provider", "mock", "-p", "hello", "world"], GLOBAL_OPTIONS);
  assert.equal(optionString(args, "provider"), "mock");
  assert.equal(optionBool(args, "print"), true);
  assert.deepEqual(args.positionals, ["hello", "world"]);
  assert.deepEqual(args.unknown, []);
});

test("supports --flag=value and numbers", () => {
  const args = parseArgs(["--max-tokens=2048", "--temperature", "0.2"], GLOBAL_OPTIONS);
  assert.equal(optionNumber(args, "max-tokens"), 2048);
  assert.equal(optionNumber(args, "temperature"), 0.2);
});

test("rejects invalid enum values with a helpful error", () => {
  assert.throws(() => parseArgs(["--permission-mode", "wild"], GLOBAL_OPTIONS), /must be one of/);
});

test("rejects a missing value", () => {
  assert.throws(() => parseArgs(["--model"], GLOBAL_OPTIONS), /requires a value/);
});

test("collects unknown flags instead of dropping them", () => {
  const args = parseArgs(["--nope", "-z"], GLOBAL_OPTIONS);
  assert.deepEqual(args.unknown, ["--nope", "-z"]);
  assert.deepEqual(args.positionals, []);
});

test("keepUnknown keeps unrecognised flags as positionals (subcommand args)", () => {
  const args = parseArgs(["add", "fs", "npx", "-y", "@modelcontextprotocol/server-filesystem"], GLOBAL_OPTIONS, {
    keepUnknown: true,
  });
  assert.deepEqual(args.positionals, ["add", "fs", "npx", "-y", "@modelcontextprotocol/server-filesystem"]);
  assert.deepEqual(args.unknown, []);
});

test("everything after `--` lands in passthrough", () => {
  const args = parseArgs(["add", "fs", "--", "npx", "-y", "pkg"], GLOBAL_OPTIONS, { keepUnknown: true });
  assert.deepEqual(args.passthrough, ["npx", "-y", "pkg"]);
});

test("splitAtCommand finds the subcommand and skips option values", () => {
  const split = splitAtCommand(["--cwd", "/tmp", "team", "build it", "--plan-only"], GLOBAL_OPTIONS, ["team"]);
  assert.deepEqual(split.head, ["--cwd", "/tmp"]);
  assert.equal(split.command, "team");
  assert.deepEqual(split.tail, ["build it", "--plan-only"]);
});

test("splitAtCommand does not mistake an option value for a command", () => {
  const split = splitAtCommand(["--agent", "team", "do the work"], GLOBAL_OPTIONS, ["team"]);
  assert.equal(split.command, undefined);
  assert.deepEqual(split.head, ["--agent", "team", "do the work"]);
});

test("splitAtCommand leaves plain prompts alone", () => {
  const split = splitAtCommand(["explain", "this", "repo"], GLOBAL_OPTIONS, ["team"]);
  assert.equal(split.command, undefined);
});

test("subcommand-specific options are parsed after the command", () => {
  const split = splitAtCommand(["team", "ship it", "--max-parallel", "5"], GLOBAL_OPTIONS, ["team"]);
  assert.equal(split.command, "team");
  const specs = [...GLOBAL_OPTIONS, ...(COMMAND_OPTIONS.team ?? [])];
  const tail = parseArgs(split.tail, specs, { keepUnknown: true });
  assert.equal(optionNumber(tail, "max-parallel"), 5);
  assert.equal(optionBool(tail, "plan-only"), false);
  assert.deepEqual(tail.positionals, ["ship it"]);
});

test("boolean command option --plan-only parses", () => {
  const specs = [...GLOBAL_OPTIONS, ...(COMMAND_OPTIONS.team ?? [])];
  const tail = parseArgs(["goal", "--plan-only"], specs, { keepUnknown: true });
  assert.equal(optionBool(tail, "plan-only"), true);
});
