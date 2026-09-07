import { after, beforeEach, describe, it } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  createSurface, getMuxBackend, sendCommand, sendEscape, readScreen,
  readScreenAsync, closeSurface, renameCurrentTab, pollForExit,
} from "../pi-extension/subagents/mux.ts";

const directory = mkdtempSync(join(tmpdir(), "orca adapter test-"));
const cli = join(directory, "orca");
const log = join(directory, "calls.jsonl");
const originalEnv = { ...process.env };

// The fake executable is the external CLI boundary; production routing and parsing run unchanged.
writeFileSync(cli, `#!/usr/bin/env node
const fs = require("node:fs");
const args = process.argv.slice(2);
fs.appendFileSync(process.env.ORCA_TEST_LOG, JSON.stringify(args) + "\\n");
const scenario = process.env.ORCA_TEST_SCENARIO;
if (scenario === "cli-error") process.exit(1);
if (scenario === "invalid-json") { process.stdout.write("bad json"); process.exit(0); }
let result;
switch (args[1]) {
  case "show": result = { terminal: { worktreeId: "repo::/parent worktree", executionHostId: scenario === "remote" ? "remote" : "local" } }; break;
  case "create": result = { terminal: { handle: "term_child", surface: scenario === "background" ? "background" : "visible" } }; break;
  case "send": result = { send: { accepted: scenario !== "rejected" } }; break;
  case "read": result = { terminal: { source: scenario === "stream" ? "screen-unavailable" : "screen", tail: scenario === "bad-tail" ? [42] : ["hello", "__SUBAGENT_DONE_7__"] } }; break;
  default: result = {};
}
console.log(JSON.stringify({ ok: scenario !== "not-ok", result }));
`, { mode: 0o755 });

after(() => {
  process.env = originalEnv;
  rmSync(directory, { recursive: true, force: true });
});

beforeEach(() => {
  process.env.PI_SUBAGENT_MUX = "orca";
  process.env.ORCA_TERMINAL_HANDLE = "term_parent";
  process.env.ORCA_CLI_COMMAND = cli;
  process.env.ORCA_TEST_LOG = log;
  delete process.env.ORCA_TEST_SCENARIO;
  writeFileSync(log, "");
});

function calls(): unknown[] {
  return readFileSync(log, "utf8").trim().split("\n").filter(Boolean).map((line) => JSON.parse(line));
}

describe("Orca backend", () => {
  it("detects an Orca terminal without an explicit backend override", () => {
    for (const key of ["PI_SUBAGENT_MUX", "CMUX_SOCKET_PATH", "TMUX", "ZELLIJ", "ZELLIJ_SESSION_NAME", "WEZTERM_UNIX_SOCKET"]) {
      delete process.env[key];
    }
    assert.equal(getMuxBackend(), "orca");
  });

  it("creates a tab in the parent's worktree without requesting focus", () => {
    assert.equal(getMuxBackend(), "orca");
    assert.equal(createSurface("Worker"), "term_child");
    assert.deepEqual(calls(), [
      ["terminal", "show", "--terminal", "term_parent", "--json"],
      ["terminal", "create", "--worktree", "id:repo::/parent worktree", "--title", "Worker", "--json"],
    ]);
  });

  it("requires a caller handle even when Orca is explicitly selected", () => {
    delete process.env.ORCA_TERMINAL_HANDLE;
    assert.equal(getMuxBackend(), null);
  });

  it("keeps command text literal and targets only the supplied terminal", () => {
    const command = "echo '$HOME'\n# \"quotes\"; `literal`";
    sendCommand("term_child", command);
    sendEscape("term_child");
    closeSurface("term_child");
    renameCurrentTab("Planning");
    assert.deepEqual(calls(), [
      ["terminal", "send", "--terminal", "term_child", "--text", command, "--enter", "--json"],
      ["terminal", "send", "--terminal", "term_child", "--text", "\u001b", "--json"],
      ["terminal", "close", "--terminal", "term_child", "--json"],
      ["terminal", "rename", "--terminal", "term_parent", "--title", "Planning", "--json"],
    ]);
  });

  it("reads rendered output through both APIs and detects the completion sentinel", async () => {
    assert.equal(readScreen("term_child", 5), "hello\n__SUBAGENT_DONE_7__");
    assert.equal(await readScreenAsync("term_child", 5), "hello\n__SUBAGENT_DONE_7__");
    assert.deepEqual(await pollForExit("term_child", new AbortController().signal, { interval: 1 }), {
      reason: "sentinel", exitCode: 7,
    });
    for (const call of calls()) {
      assert.deepEqual(call, ["terminal", "read", "--terminal", "term_child", "--screen", "--limit", "5", "--json"]);
    }
  });

  it("rejects a remote parent before creating a child", () => {
    process.env.ORCA_TEST_SCENARIO = "remote";
    assert.throws(() => createSurface("Worker"), /Orca returned/);
    assert.equal(calls().length, 1);
  });

  it("closes a background-only child and reports failed visible-tab creation", () => {
    process.env.ORCA_TEST_SCENARIO = "background";
    assert.throws(() => createSurface("Worker"), /visible subagent tab/);
    assert.deepEqual(calls().at(-1), ["terminal", "close", "--terminal", "term_child", "--json"]);
  });

  for (const scenario of ["stream", "bad-tail", "not-ok", "invalid-json", "cli-error"]) {
    it(`surfaces ${scenario} read failures in both APIs`, async () => {
      process.env.ORCA_TEST_SCENARIO = scenario;
      assert.throws(() => readScreen("term_child", 5));
      await assert.rejects(readScreenAsync("term_child", 5));
    });
  }

  it("reports rejected input", () => {
    process.env.ORCA_TEST_SCENARIO = "rejected";
    assert.throws(() => sendCommand("term_child", "echo hi"), /Orca returned/);
  });

  it("cancels completion polling after a read failure", async () => {
    process.env.ORCA_TEST_SCENARIO = "stream";
    const controller = new AbortController();
    await assert.rejects(pollForExit("term_child", controller.signal, {
      interval: 1,
      onTick: () => controller.abort(),
    }), /Aborted/);
  });
});
