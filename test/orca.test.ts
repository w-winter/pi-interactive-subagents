import { after, beforeEach, describe, it } from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { ExtensionAPI, ExtensionContext, ToolDefinition } from "@mariozechner/pi-coding-agent";
import { Value } from "@sinclair/typebox/value";
import subagentsExtension from "../pi-extension/subagents/index.ts";
import { pollForExit } from "../pi-extension/subagents/completion.ts";
import {
  createSurface, getMuxBackend, sendCommand, sendEscape, readScreen,
  readScreenAsync, closeSurface, renameCurrentTab,
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
  case "show":
    if (scenario === "probe-error") { console.log(JSON.stringify({ ok: false })); process.exit(0); }
    if (process.env.ORCA_TEST_EXIT) fs.writeFileSync(process.env.ORCA_TEST_EXIT, JSON.stringify({ type: "done" }));
    result = { terminal: {
      worktreeId: "repo::/parent worktree", executionHostId: scenario === "remote" ? "remote" : "local",
      ...(scenario?.startsWith("closed") ? { exitCause: { kind: "operator_close" } } : {}),
    } }; break;
  case "create": result = { terminal: { handle: "term_child", surface: scenario === "background" ? "background" : "visible" } }; break;
  case "send": result = { send: { accepted: scenario !== "rejected" } }; break;
  case "read": result = { terminal: {
    source: scenario === "stream" || scenario === "closed-unreadable" ? "screen-unavailable" : "screen",
    tail: scenario === "bad-tail" ? [42] : scenario?.startsWith("closed") || scenario === "waiting" || scenario === "probe-error" ? ["hello"] : ["hello", "__SUBAGENT_DONE_7__"],
  } }; break;
  default: result = {};
}
console.log(JSON.stringify({ ok: scenario !== "not-ok", result }));
`, { mode: 0o755 });

after(() => {
  process.env = originalEnv;
  execFileSync("trash", [directory]);
});

beforeEach(() => {
  process.env.PI_SUBAGENT_MUX = "orca";
  process.env.ORCA_TERMINAL_HANDLE = "term_parent";
  process.env.ORCA_CLI_COMMAND = cli;
  process.env.ORCA_TEST_LOG = log;
  delete process.env.ORCA_TEST_SCENARIO;
  delete process.env.ORCA_TEST_EXIT;
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
      ["terminal", "show", "--terminal", "term_child", "--json"],
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

  for (const scenario of ["closed-readable", "closed-unreadable"]) {
    it(`settles ${scenario} terminals without a child exit file`, async () => {
      process.env.ORCA_TEST_SCENARIO = scenario;
      const controller = new AbortController();
      const result = await pollForExit("term_child", controller.signal, {
        interval: 1,
        onTick: () => controller.abort(),
      });
      assert.deepEqual(result, { reason: "quit", exitCode: 0 });
      closeSurface("term_child");
      assert.ok(!calls().some((call) => Array.isArray(call) && call[1] === "close"));
    });
  }

  for (const scenario of ["waiting", "stream", "probe-error"]) {
    it(`keeps ${scenario} children tracked until closure is confirmed`, async () => {
      process.env.ORCA_TEST_SCENARIO = scenario;
      const controller = new AbortController();
      let ticks = 0;
      const result = await pollForExit("term_child", controller.signal, {
        interval: 1,
        onTick() {
          if (++ticks > 1) controller.abort();
          process.env.ORCA_TEST_SCENARIO = "closed-readable";
        },
      });
      assert.equal(ticks, 1);
      assert.deepEqual(result, { reason: "quit", exitCode: 0 });
    });
  }

  it("honors completion written during the lifecycle query", async () => {
    const sessionFile = join(directory, "late-completion.jsonl");
    process.env.ORCA_TEST_SCENARIO = "closed-readable";
    process.env.ORCA_TEST_EXIT = `${sessionFile}.exit`;
    const controller = new AbortController();
    assert.deepEqual(await pollForExit("term_child", controller.signal, {
      interval: 1, sessionFile, onTick: () => controller.abort(),
    }), { reason: "done", exitCode: 0 });
  });

  it("cancels completion polling after a read failure", async () => {
    process.env.ORCA_TEST_SCENARIO = "stream";
    const controller = new AbortController();
    await assert.rejects(pollForExit("term_child", controller.signal, {
      interval: 1,
      onTick: () => controller.abort(),
    }), { name: "AbortError" });
  });

  it("reports closure and removes fresh, resumed, and Claude children from tracking", { timeout: 5000 }, async (t) => {
    type NamedChildRequest = { name: string };
    type Tool = {
      execute(id: string, params: NamedChildRequest, signal: AbortSignal | undefined, update: undefined, ctx: ExtensionContext): ReturnType<ToolDefinition["execute"]>;
    };
    type Message = Parameters<ExtensionAPI["sendMessage"]>[0];
    const tools = new Map<string, Tool>();
    let shutdown = () => {};
    let deliver: (message: Message) => void = () => {};
    const api: Partial<ExtensionAPI> = {
      on(event: string, handler: (...args: never[]) => void) {
        if (event === "session_shutdown") shutdown = () => { handler(); };
      },
      registerTool(tool) {
        tools.set(tool.name, {
          async execute(id, params, signal, update, ctx) {
            assert.ok(Value.Check(tool.parameters, params));
            return tool.execute(id, params, signal, update, ctx);
          },
        });
      },
      registerCommand() {}, registerMessageRenderer() {},
      sendMessage(message: Message) { deliver(message); },
      getAllTools() { return []; },
    };
    // SAFETY: The runtime double supplies registration, delivery, and shutdown, the only API paths these tools use.
    subagentsExtension(api as ExtensionAPI);
    t.after(() => shutdown());
    process.env.ORCA_TEST_SCENARIO = "closed-unreadable";
    process.env.PI_SUBAGENT_SHELL_READY_DELAY_MS = "0";
    process.env.PI_CODING_AGENT_DIR = join(directory, "agent");
    const agentDir = join(process.env.PI_CODING_AGENT_DIR, "agents");
    mkdirSync(agentDir, { recursive: true });
    writeFileSync(join(agentDir, "lifecycle-claude.md"), "---\ncli: claude\n---\nTest agent.\n");
    const sessionFile = join(directory, "parent.jsonl");
    writeFileSync(sessionFile, [
      { type: "session", version: 3, id: "lifecycle-test", cwd: directory },
      { type: "model_change", id: "model", parentId: null, provider: "fixture", modelId: "unpaid" },
      { type: "thinking_level_change", id: "thinking", parentId: "model", thinkingLevel: "off" },
    ].map((entry) => JSON.stringify(entry)).join("\n") + "\n");
    const context = {
      cwd: directory,
      sessionManager: {
        getSessionFile: () => sessionFile,
        getSessionId: () => "lifecycle-test",
        getSessionDir: () => directory,
      },
    };
    // SAFETY: The fake CLI never launches a model; these tools need only cwd and persistent-session paths from the runtime context.
    const ctx = context as Parameters<Tool["execute"]>[4];
    const cases = [
      { tool: "subagent", params: { name: "Fresh child", task: "Wait", cwd: directory } },
      { tool: "subagent_resume", params: { name: "Resumed child", sessionPath: sessionFile, autoExit: false } },
      { tool: "subagent", params: { name: "Claude child", task: "Wait", agent: "lifecycle-claude", cwd: directory } },
    ];
    const receipt: Message[] = [];
    for (const entry of cases) {
      const completed = new Promise<Message>((resolve) => { deliver = resolve; });
      const tool = tools.get(entry.tool);
      assert.ok(tool);
      await tool.execute("launch", entry.params, undefined, undefined, ctx);
      const message = await completed;
      assert.equal(message.customType, "subagent_result");
      assert.match(JSON.stringify(message.content), /closed by user/);
      const interrupt = tools.get("subagent_interrupt");
      assert.ok(interrupt);
      const result = await interrupt.execute("check", { name: entry.params.name }, undefined, undefined, ctx);
      assert.match(JSON.stringify(result.content), /No running subagent/);
      receipt.push(message);
    }
    const artifacts = join(import.meta.dirname, "artifacts", "terminal-lifecycle");
    mkdirSync(artifacts, { recursive: true });
    writeFileSync(join(artifacts, "receipt.json"), JSON.stringify({ results: receipt, paidRequests: 0 }, null, 2) + "\n");
    t.diagnostic(`Verification artifact: ${artifacts}/receipt.json`);
  });
});
