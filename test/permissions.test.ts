/**
 * Permission engine: rule syntax, modes, and the unattended fallback.
 *
 * Author: Faizan Hameed (https://faizcasm.me) - Founder of Ryuksaidso
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import * as path from "node:path";

import {
  checkPermission,
  isReadOnlyCommand,
  parseRule,
  ruleMatches,
  suggestAllowRule,
  type PermissionContext,
  type PermissionGate,
  type PermissionRequest,
} from "../src/core/permissions.js";

const CWD = path.resolve("/home/project");

function ctx(patch: Partial<PermissionContext> = {}): PermissionContext {
  return { mode: "default", allow: [], deny: [], interactive: false, cwd: CWD, ...patch };
}

const denyGate: PermissionGate = {
  async ask() {
    return { action: "deny", reason: "no human" };
  },
};

test("parseRule splits tool and qualifier", () => {
  assert.deepEqual(parseRule("Bash(git:*)"), { tool: "Bash", qualifier: "git:*" });
  assert.deepEqual(parseRule("Read"), { tool: "Read", qualifier: undefined });
  assert.deepEqual(parseRule("WebFetch(domain:github.com)"), { tool: "WebFetch", qualifier: "domain:github.com" });
});

test("deny rules win over allow rules", async () => {
  const decision = await checkPermission(
    { tool: "Bash", input: { command: "git push" }, target: "git push" },
    ctx({ allow: ["Bash(git:*)"], deny: ["Bash(git push)"] }),
  );
  assert.equal(decision.action, "deny");
  assert.match(decision.reason ?? "", /deny rule/);
});

test("allow rules permit otherwise-restricted actions", async () => {
  const decision = await checkPermission(
    { tool: "Bash", input: { command: "npm run build" }, target: "npm run build" },
    ctx({ allow: ["Bash(npm:*)"] }),
  );
  assert.equal(decision.action, "allow");
});

test("path glob rules match files under a directory", async () => {
  const request: PermissionRequest = { tool: "Edit", input: { file_path: path.join(CWD, "src/app.ts") }, target: path.join(CWD, "src/app.ts") };
  assert.equal((await checkPermission(request, ctx({ allow: ["Edit(src/**)"] }))).action, "allow");
  assert.equal((await checkPermission(request, ctx({ allow: ["Edit(docs/**)"] }))).action, "deny");
});

test("WebFetch domain rules only match that host", () => {
  const request = (url: string): PermissionRequest => ({ tool: "WebFetch", input: { url }, target: url });
  assert.equal(ruleMatches("WebFetch(domain:github.com)", request("https://github.com/a/b"), CWD), true);
  assert.equal(ruleMatches("WebFetch(domain:github.com)", request("https://api.github.com/x"), CWD), true);
  assert.equal(ruleMatches("WebFetch(domain:github.com)", request("https://evil.com/github.com"), CWD), false);
});

test("plan mode denies mutations but allows read-only work", async () => {
  const write = await checkPermission(
    { tool: "Write", input: { file_path: path.join(CWD, "a.ts") }, target: path.join(CWD, "a.ts") },
    ctx({ mode: "plan" }),
  );
  assert.equal(write.action, "deny");
  assert.match(write.reason ?? "", /plan mode/);

  const read = await checkPermission({ tool: "Read", input: { file_path: path.join(CWD, "a.ts") }, target: path.join(CWD, "a.ts") }, ctx({ mode: "plan" }));
  assert.equal(read.action, "allow");
});

test("plan mode treats MCP tools as mutating", async () => {
  const mcp = await checkPermission(
    { tool: "mcp__fs__write_file", input: { path: "/tmp/x" }, target: "/tmp/x" },
    ctx({ mode: "plan" }),
  );
  assert.equal(mcp.action, "deny");
  assert.match(mcp.reason ?? "", /plan mode/);
});

test("wildcard tool rules match any tool", () => {
  assert.equal(ruleMatches("*", { tool: "Bash", input: {}, target: "rm -rf x" }, CWD), true);
  assert.equal(ruleMatches("mcp__github__*", { tool: "mcp__github__search", input: {}, target: "x" }, CWD), true);
  assert.equal(ruleMatches("mcp__github__*", { tool: "mcp__fs__read_file", input: {}, target: "x" }, CWD), false);
  assert.equal(ruleMatches("Read", { tool: "Write", input: {}, target: "/tmp/x" }, CWD), false);
});

test("acceptEdits auto-approves edits but still gates shell", async () => {
  const edit = await checkPermission(
    { tool: "Edit", input: { file_path: path.join(CWD, "a.ts") }, target: path.join(CWD, "a.ts") },
    ctx({ mode: "acceptEdits" }),
  );
  assert.equal(edit.action, "allow");

  const shell = await checkPermission({ tool: "Bash", input: { command: "rm -rf build" }, target: "rm -rf build" }, ctx({ mode: "acceptEdits" }));
  assert.equal(shell.action, "deny");
});

test("bypassPermissions allows everything", async () => {
  const decision = await checkPermission({ tool: "Bash", input: { command: "rm -rf /" }, target: "rm -rf /" }, ctx({ mode: "bypassPermissions" }));
  assert.equal(decision.action, "allow");
});

test("non-interactive sessions deny instead of hanging", async () => {
  const decision = await checkPermission({ tool: "Write", input: { file_path: path.join(CWD, "a.ts") }, target: path.join(CWD, "a.ts") }, ctx());
  assert.equal(decision.action, "deny");
  assert.match(decision.reason ?? "", /non-interactive/);
});

test("read-only shell commands never prompt", async () => {
  const decision = await checkPermission({ tool: "Bash", input: { command: "git status" }, target: "git status" }, ctx({ gate: denyGate, interactive: true }));
  assert.equal(decision.action, "allow");
});

test("the gate is consulted for dangerous commands when interactive", async () => {
  let asked = false;
  const gate: PermissionGate = {
    async ask() {
      asked = true;
      return { action: "allow", reason: "yes" };
    },
  };
  const decision = await checkPermission({ tool: "Bash", input: { command: "rm -rf build" }, target: "rm -rf build" }, ctx({ gate, interactive: true }));
  assert.equal(asked, true);
  assert.equal(decision.action, "allow");
});

test("isReadOnlyCommand classifies common commands", () => {
  assert.equal(isReadOnlyCommand("git log --oneline"), true);
  assert.equal(isReadOnlyCommand("ls -la src"), true);
  assert.equal(isReadOnlyCommand("git status && git log"), true);
  assert.equal(isReadOnlyCommand("git push"), false);
  assert.equal(isReadOnlyCommand("rm -rf dist"), false);
  assert.equal(isReadOnlyCommand("echo hi > out.txt"), false);
});

test("suggestAllowRule proposes useful persistent rules", () => {
  assert.equal(suggestAllowRule({ tool: "Bash", input: {}, target: "npm test" }), "Bash(npm:*)");
  assert.equal(
    suggestAllowRule({ tool: "Write", input: {}, target: path.join(CWD, "src", "app.ts") }),
    "Write(/home/project/src/**)",
  );
  assert.match(suggestAllowRule({ tool: "WebFetch", input: {}, target: "https://docs.anthropic.com/x" }), /^WebFetch\(domain:/);
});
