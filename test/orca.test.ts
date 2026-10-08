import { after, beforeEach, describe, it } from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, readFileSync, readdirSync, statSync, symlinkSync, writeFileSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { ExtensionAPI, ExtensionContext, ExtensionCommandContext, ToolDefinition } from "@mariozechner/pi-coding-agent";
import { Value } from "@sinclair/typebox/value";
import { Type } from "@sinclair/typebox";
import subagentsExtension, { __test__ } from "../pi-extension/subagents/index.ts";
import { createTestEnv, startPi } from "./integration/harness.ts";
import { pollForExit } from "../pi-extension/subagents/completion.ts";
import { findLastAssistantMessage, getBranchEntries } from "../pi-extension/subagents/session.ts";
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

type LifecycleRequest =
  | { name: string; task: string; cwd: string; agent?: string; autoExit?: boolean; interactive?: boolean; model?: string }
  | { sessionPath: string; name?: string; message?: string };
type LifecycleReason = "startup" | "reload" | "quit" | "new" | "resume" | "fork";
type LifecycleHook = (event: { type: string; reason: LifecycleReason }, ctx: ExtensionContext) => void | Promise<void>;

function lifecycleRuntime(extension = subagentsExtension) {
  const registered = new Map<string, (params: LifecycleRequest, ctx: ExtensionContext) => ReturnType<ToolDefinition["execute"]>>();
  const commands = new Map<string, Parameters<ExtensionAPI["registerCommand"]>[1]>();
  const userMessages: string[] = [];
  const hooks = new Map<string, LifecycleHook>();
  const messages: Parameters<ExtensionAPI["sendMessage"]>[0][] = [];
  let deliver: (message: Parameters<ExtensionAPI["sendMessage"]>[0]) => void = () => {};
  const api: Partial<ExtensionAPI> = {
    registerTool(tool) {
      registered.set(tool.name, async (params, ctx) => {
        assert.ok(Value.Check(tool.parameters, params));
        return tool.execute("test", params, undefined, undefined, ctx);
      });
    },
    registerCommand(name, command) { commands.set(name, command); }, registerMessageRenderer() {},
    sendUserMessage(message) { assert.ok(Value.Check(Type.String(), message)); userMessages.push(message); },
    sendMessage(message) { messages.push(message); deliver(message); },
    getAllTools() { return []; },
  };
  // SAFETY: This double implements the registration and delivery APIs used by the lifecycle tests.
  extension({ ...api, on(event: string, handler: LifecycleHook) { hooks.set(event, handler); } } as ExtensionAPI);
  const root = mkdtempSync(join(directory, "lifecycle-"));
  const sessionFile = join(root, "parent.jsonl");
  writeFileSync(sessionFile, [
    { type: "session", version: 3, id: "parent", cwd: root },
    { type: "model_change", id: "model", parentId: null, provider: "fixture", modelId: "unpaid" },
    { type: "thinking_level_change", id: "thinking", parentId: "model", thinkingLevel: "off" },
  ].map((entry) => JSON.stringify(entry)).join("\n") + "\n");
  // SAFETY: No interactive UI or real child runs; the tools use only these session paths and cwd.
  const ctx = { cwd: root, hasUI: false, sessionManager: {
    getSessionFile: () => sessionFile, getSessionId: () => "parent", getSessionDir: () => root,
  } } as ExtensionContext;
  return {
    root, sessionFile, ctx, messages, commands, userMessages,
    async event(event: string, reason: LifecycleReason, context = ctx) {
      const hook = hooks.get(event);
      assert.ok(hook);
      await hook({ type: event, reason }, context);
    },
    nextMessage: () => new Promise<Parameters<ExtensionAPI["sendMessage"]>[0]>((resolve) => { deliver = resolve; }),
    async execute(name: string, params: LifecycleRequest) {
      const tool = registered.get(name);
      assert.ok(tool);
      return tool(params, ctx);
    },
  };
}

describe("Parent lifecycle ownership", () => {
  for (const reason of ["reload", "quit"] as const) {
    it(`keeps ${reason} quiet when no children are retained`, async (t) => {
      const logs: string[] = [];
      t.mock.method(console, "info", (message: string) => { logs.push(message); });
      const runtime = lifecycleRuntime();
      await runtime.event("session_start", "startup");
      await runtime.event("session_shutdown", reason);
      assert.equal(logs.some((message) => message.startsWith("[subagents:parent-lifecycle]")), false);
    });
  }

  for (const resumed of [false, true]) {
    it(`reattaches a ${resumed ? "resumed" : "fresh"} child after module reload and delivers once`, { timeout: 5000 }, async (t) => {
      process.env.ORCA_TEST_SCENARIO = "waiting";
      process.env.PI_SUBAGENT_SHELL_READY_DELAY_MS = "0";
      process.env.PI_CODING_AGENT_DIR = join(directory, "isolated-config");
      const old = lifecycleRuntime();
      t.after(() => old.event("session_shutdown", "quit"));
      await old.event("session_start", "startup");
      const launched = await old.execute(resumed ? "subagent_resume" : "subagent", resumed
        ? { name: "Reload child", sessionPath: old.sessionFile }
        : { name: "Reload child", task: "Wait", cwd: old.root });
      const active = Array.from(__test__.runningSubagents.values()).find((child) => child.name === "Reload child");
      assert.ok(active);
      const childSession = active.sessionFile;
      await old.event("session_shutdown", "reload");
      assert.ok(!calls().some((call) => Array.isArray(call) && call[1] === "close"), "reload must not close the child");
      assert.deepEqual(old.messages, [], "observer detachment must not report cancellation");
      // A fresh import models Pi replacing the extension module during /reload.
      const reloaded = await import(`../pi-extension/subagents/index.ts?reload=${resumed}`);
      const next = lifecycleRuntime(reloaded.default);
      t.after(() => next.event("session_shutdown", "quit", old.ctx));
      assert.equal(reloaded.__test__.runningSubagents.size, 1, "the child must remain tracked after reload");
      const delivered = next.nextMessage();
      if (!resumed) writeFileSync(childSession, readFileSync(old.sessionFile, "utf8"));
      writeFileSync(childSession, readFileSync(childSession, "utf8") + JSON.stringify({
        type: "message", id: "reload-answer", parentId: "thinking",
        message: { role: "assistant", content: [{ type: "text", text: "Result after reload" }] },
      }) + "\n", { flag: "w" });
      writeFileSync(`${childSession}.exit`, JSON.stringify({ type: "done" }));
      await next.event("session_start", "reload", old.ctx);
      const result = await delivered;
      assert.match(JSON.stringify(result.content), /Result after reload/);
      assert.equal(next.messages.length, 1);
      assert.equal(old.messages.length, 0);
      assert.equal(reloaded.__test__.runningSubagents.size, 0);
      const artifacts = join(import.meta.dirname, "artifacts", "parent-lifecycle");
      mkdirSync(artifacts, { recursive: true });
      writeFileSync(join(artifacts, `reload-${resumed}.json`), JSON.stringify({ launched, result, calls: calls(), paidRequests: 0 }, null, 2));
    });
  }

  for (const mode of ["fresh", "resume", "resume-without-new-answer"] as const) {
    it(`delivers only selected-branch output for ${mode}`, async (t) => {
      process.env.ORCA_TEST_SCENARIO = "waiting";
      process.env.PI_SUBAGENT_SHELL_READY_DELAY_MS = "0";
      const runtime = lifecycleRuntime();
      t.after(() => runtime.event("session_shutdown", "quit"));
      const answer = { type: "message", id: "selected", parentId: "thinking", message: {
        role: "assistant", content: [{ type: "text", text: "Selected answer" }],
      } };
      if (mode === "resume-without-new-answer") {
        writeFileSync(runtime.sessionFile, JSON.stringify(answer) + "\n", { flag: "a" });
      }
      const delivered = runtime.nextMessage();
      const launched = await runtime.execute(mode === "fresh" ? "subagent" : "subagent_resume", mode === "fresh"
        ? { name: "Branch child", task: "Wait", cwd: runtime.root }
        : { name: "Branch child", sessionPath: runtime.sessionFile });
      const child = Array.from(__test__.runningSubagents.values()).find((entry) => entry.name === "Branch child");
      assert.ok(child);
      if (mode === "fresh") writeFileSync(child.sessionFile, readFileSync(runtime.sessionFile));
      const entries = [
        ...(mode === "resume-without-new-answer" ? [] : [answer]),
        { ...answer, id: "abandoned", parentId: "selected", message: {
          role: "assistant", content: [{ type: "text", text: "Abandoned answer" }],
        } },
        { type: "session_info", id: "selection", parentId: "selected", name: "Selected branch" },
      ];
      writeFileSync(child.sessionFile, entries.map((entry) => JSON.stringify(entry)).join("\n") + "\n", { flag: "a" });
      writeFileSync(`${child.sessionFile}.exit`, JSON.stringify({ type: "done" }));
      const result = await delivered;
      assert.match(JSON.stringify(result.content), mode === "resume-without-new-answer" ? /without new output/ : /Selected answer/);
      assert.doesNotMatch(JSON.stringify(result.content), /Abandoned answer/);
      assert.equal(runtime.messages.length, 1);
      const artifacts = join(import.meta.dirname, "artifacts", "branch-result");
      mkdirSync(artifacts, { recursive: true });
      writeFileSync(join(artifacts, `${mode}-delivery.json`), JSON.stringify({ launched, result, paidRequests: 0 }, null, 2));
    });
  }

  it("rejects concurrent and alias resumes, then releases a failed launch claim", { timeout: 5000 }, async (t) => {
    process.env.ORCA_TEST_SCENARIO = "waiting";
    process.env.PI_SUBAGENT_SHELL_READY_DELAY_MS = "0";
    const runtime = lifecycleRuntime();
    t.after(() => runtime.event("session_shutdown", "quit"));
    const params = { name: "Resume owner", sessionPath: runtime.sessionFile };
    const first = runtime.execute("subagent_resume", params);
    const concurrent = await runtime.execute("subagent_resume", params);
    assert.match(JSON.stringify(concurrent.content), /already (running|being resumed)/);
    await first;
    const alias = join(runtime.root, "alias.jsonl");
    symlinkSync(runtime.sessionFile, alias);
    const aliasResult = await runtime.execute("subagent_resume", { ...params, sessionPath: alias });
    assert.match(JSON.stringify(aliasResult.content), /already (running|being resumed)/);
    assert.equal(calls().filter((call) => Array.isArray(call) && call[1] === "create").length, 1);
    await runtime.event("session_shutdown", "quit");
    const retry = lifecycleRuntime();
    t.after(() => retry.event("session_shutdown", "quit"));
    process.env.ORCA_TEST_SCENARIO = "rejected";
    await assert.rejects(retry.execute("subagent_resume", { name: "Retry", sessionPath: retry.sessionFile }), /Orca returned/);
    assert.equal(calls().filter((call) => Array.isArray(call) && call[1] === "close").length, 2,
      "quit closes the first runner and failed startup closes its unused terminal");
    process.env.ORCA_TEST_SCENARIO = "waiting";
    const retried = await retry.execute("subagent_resume", { name: "Retry", sessionPath: retry.sessionFile });
    assert.match(JSON.stringify(retried.content), /resumed/);
  });

  it("rejects resuming a fresh active child and permits it after completion", { timeout: 5000 }, async (t) => {
    process.env.ORCA_TEST_SCENARIO = "waiting";
    process.env.PI_SUBAGENT_SHELL_READY_DELAY_MS = "0";
    process.env.PI_CODING_AGENT_DIR = join(directory, "fresh-config");
    const runtime = lifecycleRuntime();
    t.after(() => runtime.event("session_shutdown", "quit"));
    await runtime.execute("subagent", { name: "Fresh owner", task: "Wait", cwd: runtime.root });
    const child = Array.from(__test__.runningSubagents.values()).find((entry) => entry.name === "Fresh owner");
    assert.ok(child);
    writeFileSync(child.sessionFile, readFileSync(runtime.sessionFile, "utf8"));
    const duplicate = await runtime.execute("subagent_resume", { sessionPath: child.sessionFile });
    assert.match(JSON.stringify(duplicate.content), /already running/);
    const completed = runtime.nextMessage();
    writeFileSync(`${child.sessionFile}.exit`, JSON.stringify({ type: "done" }));
    await completed;
    const resumed = await runtime.execute("subagent_resume", { sessionPath: child.sessionFile });
    assert.match(JSON.stringify(resumed.content), /resumed/);
  });

  it("finishes a real completion during reload before invalidating the old delivery API", async () => {
    process.env.PI_SUBAGENT_SHELL_READY_DELAY_MS = "0";
    process.env.PI_CODING_AGENT_DIR = join(directory, "racing-config");
    const runtime = lifecycleRuntime();
    await runtime.execute("subagent", { name: "Finishing child", task: "Wait", cwd: runtime.root });
    await runtime.event("session_shutdown", "reload");
    assert.equal(runtime.messages.length, 1);
    assert.match(JSON.stringify(runtime.messages[0].content), /failed \(exit code 7\)/);
    assert.match(JSON.stringify(runtime.messages[0].content), /Stderr:/);
    assert.equal(__test__.runningSubagents.size, 0);
  });

  it("keeps Claude children across reload and still closes children on parent quit", async (t) => {
    process.env.ORCA_TEST_SCENARIO = "waiting";
    process.env.PI_SUBAGENT_SHELL_READY_DELAY_MS = "0";
    process.env.PI_CODING_AGENT_DIR = join(directory, "claude-config");
    const agents = join(process.env.PI_CODING_AGENT_DIR, "agents");
    mkdirSync(agents, { recursive: true });
    writeFileSync(join(agents, "reload-claude.md"), "---\nextension: pi-interactive-subagents\ncli: claude\n---\nTest only.\n");
    const old = lifecycleRuntime();
    await old.execute("subagent", { name: "Claude survivor", task: "Wait", agent: "reload-claude", cwd: old.root });
    await old.event("session_shutdown", "reload");
    assert.equal(old.messages.length, 0);
    assert.ok(!calls().some((call) => Array.isArray(call) && call[1] === "close"));
    const next = lifecycleRuntime();
    t.after(() => next.event("session_shutdown", "quit"));
    await next.event("session_start", "reload", old.ctx);
    await next.event("session_shutdown", "quit");
    assert.equal(next.messages.length, 1);
    assert.ok(calls().some((call) => Array.isArray(call) && call[1] === "close"));
    assert.equal(__test__.runningSubagents.size, 0);
  });

  for (const resumed of [false, true]) {
    it(`retains stderr and exit status for a ${resumed ? "resumed" : "fresh"} Pi crash`, async (t) => {
      process.env.ORCA_TEST_SCENARIO = "waiting";
      process.env.PI_SUBAGENT_SHELL_READY_DELAY_MS = "0";
      process.env.PI_CODING_AGENT_DIR = join(directory, "crash-config");
      const runtime = lifecycleRuntime();
      t.after(() => runtime.event("session_shutdown", "quit"));
      const launched = await runtime.execute(resumed ? "subagent_resume" : "subagent", resumed
        ? { name: "Crash", sessionPath: runtime.sessionFile }
        : { name: "Crash", task: "Wait", cwd: runtime.root });
      const paths = Type.Object({ launchScriptFile: Type.String(), stderrFile: Type.String() });
      assert.ok(Value.Check(paths, launched.details), "launch must advertise a durable stderr path");
      const fakePi = join(runtime.root, "fake-pi.bash");
      // Bash resolves this function at the external executable boundary, leaving the generated script unchanged.
      writeFileSync(fakePi, "function /opt/homebrew/bin/pi() { printf 'TUI output\\n'; printf 'fatal handler error\\n' >&2; return 7; }\n");
      const output = execFileSync("bash", [launched.details.launchScriptFile], {
        encoding: "utf8", env: { ...process.env, BASH_ENV: fakePi },
      });
      assert.match(output, /TUI output\n__SUBAGENT_DONE_7__/);
      assert.doesNotMatch(output, /fatal handler error/);
      assert.equal(readFileSync(launched.details.stderrFile, "utf8"), "fatal handler error\n");
      assert.equal(statSync(launched.details.stderrFile).mode & 0o777, 0o600);
      const artifacts = join(import.meta.dirname, "artifacts", "parent-lifecycle");
      mkdirSync(artifacts, { recursive: true });
      writeFileSync(join(artifacts, `stderr-${resumed}.json`), JSON.stringify({ output, stderr: readFileSync(launched.details.stderrFile, "utf8"), paidRequests: 0 }, null, 2));
    });
  }
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

function fileTree(root: string): string[] {
  return readdirSync(root).sort().flatMap((name) => {
    const path = join(root, name);
    return statSync(path).isDirectory()
      ? [name + "/", ...fileTree(path).map((child) => `${name}/${child}`)]
      : [name];
  });
}

describe("Fresh Pi completion policy", () => {
  it("applies per-call exit policy before definition defaults and keeps status notifications independent", async (t) => {
    const runtime = lifecycleRuntime();
    t.after(() => runtime.event("session_shutdown", "quit"));
    process.env.ORCA_TEST_SCENARIO = "waiting";
    process.env.PI_SUBAGENT_SHELL_READY_DELAY_MS = "0";
    process.env.PI_CODING_AGENT_DIR = join(runtime.root, "config");
    const agents = join(process.env.PI_CODING_AGENT_DIR, "agents");
    mkdirSync(agents, { recursive: true });
    for (const autoExit of [false, true]) {
      writeFileSync(join(agents, `exit-${autoExit}.md`),
        `---\nextension: pi-interactive-subagents\nauto-exit: ${autoExit}\n---\nReturn the answer.\n`);
    }
    const cases = [
      { params: {}, expected: false },
      { params: { interactive: false }, expected: false },
      { params: { autoExit: true }, expected: true },
      { params: { autoExit: false }, expected: false },
      { params: { autoExit: true, interactive: true }, expected: true },
      { params: { agent: "exit-true" }, expected: true },
      { params: { agent: "exit-true", autoExit: false }, expected: false },
      { params: { agent: "exit-false", autoExit: true }, expected: true },
    ];
    const receipts = [];
    for (const [index, entry] of cases.entries()) {
      const launched = await runtime.execute("subagent", {
        name: `Exit policy ${index}`, task: "Return the answer", cwd: runtime.root, ...entry.params,
      });
      const paths = Type.Object({ launchScriptFile: Type.String(), autoExit: Type.Boolean() });
      assert.ok(Value.Check(paths, launched.details));
      assert.equal(launched.details.autoExit, entry.expected);
      const command = readFileSync(launched.details.launchScriptFile, "utf8");
      assert.match(command, new RegExp(`PI_SUBAGENT_AUTO_EXIT=${entry.expected ? "1" : "0"}`));
      assert.match(JSON.stringify(launched.content), entry.expected
        ? /Automatic exit is enabled/
        : /Automatic exit is disabled.*completed reply leaves the session open/);
      receipts.push({ params: entry.params, autoExit: launched.details.autoExit, acknowledgement: launched.content });
    }
    const artifacts = join(import.meta.dirname, "artifacts", "bare-completion");
    mkdirSync(artifacts, { recursive: true });
    writeFileSync(join(artifacts, "launch-policies.json"), JSON.stringify({ receipts, paidRequests: 0 }, null, 2));
  });

  it("delivers a bare tool-free child's settled answer once through the registered tool", { timeout: 5000 }, async (t) => {
    const runtime = lifecycleRuntime();
    t.after(() => runtime.event("session_shutdown", "quit"));
    process.env.ORCA_TEST_SCENARIO = "waiting";
    process.env.PI_SUBAGENT_SHELL_READY_DELAY_MS = "0";
    process.env.PI_CODING_AGENT_DIR = join(runtime.root, "config");
    const completed = runtime.nextMessage();
    const launched = await runtime.execute("subagent", {
      name: "Bare one-shot", task: "Return the answer without calling tools.", cwd: runtime.root,
      model: "guard-test/astra", autoExit: true,
    });
    const paths = Type.Object({ launchScriptFile: Type.String(), sessionFile: Type.String() });
    assert.ok(Value.Check(paths, launched.details));
    const fakePi = join(runtime.root, "offline-pi.bash");
    const provider = join(import.meta.dirname, "fixtures", "model-guard-provider.ts");
    writeFileSync(fakePi, `function /opt/homebrew/bin/pi() { command /opt/homebrew/bin/pi --mode json --offline --no-extensions --no-skills --no-context-files --no-tools -e '${provider}' "$@"; }\n`);
    const output = execFileSync("bash", [launched.details.launchScriptFile], {
      encoding: "utf8", env: { ...process.env, BASH_ENV: fakePi },
    });
    assert.match(output, /__SUBAGENT_DONE_0__/);
    assert.deepEqual(JSON.parse(readFileSync(`${launched.details.sessionFile}.exit`, "utf8")), { type: "done" });
    const result = await completed;
    assert.equal(result.customType, "subagent_result");
    assert.match(JSON.stringify(result.content), /astra/);
    await runtime.event("session_shutdown", "quit");
    assert.equal(runtime.messages.length, 1);
    const artifacts = join(import.meta.dirname, "artifacts", "bare-completion");
    mkdirSync(artifacts, { recursive: true });
    writeFileSync(join(artifacts, "settled-result.json"), JSON.stringify({ launched, result, output, notifications: runtime.messages.length, paidRequests: 0 }, null, 2));
  });

  it("preserves the ordinary child's launch contract through resume", async (t) => {
    const runtime = lifecycleRuntime();
    t.after(() => runtime.event("session_shutdown", "quit"));
    process.env.ORCA_TEST_SCENARIO = "waiting";
    process.env.PI_SUBAGENT_SHELL_READY_DELAY_MS = "0";
    const agentDir = join(runtime.root, "config");
    process.env.PI_CODING_AGENT_DIR = agentDir;
    mkdirSync(join(agentDir, "agents"), { recursive: true });
    writeFileSync(join(agentDir, "agents", "restricted.md"), [
      "---", "extension: pi-interactive-subagents", "model: launch-audit/snapshot",
      "tools: read", "spawning: false", "deny-tools: subagent_interrupt,subagents_list",
      "system-prompt: append", "---", "ROLE_INSTRUCTION_FROM_LAUNCH",
    ].join("\n"));
    const provider = join(import.meta.dirname, "fixtures", "launch-audit-provider.ts");
    const extension = join(import.meta.dirname, "..", "pi-extension", "subagents", "index.ts");
    const fakePi = join(runtime.root, "offline-pi.bash");
    writeFileSync(fakePi, `function /opt/homebrew/bin/pi() { command /opt/homebrew/bin/pi --mode json --offline --no-extensions --no-skills --no-context-files -e '${provider}' -e '${extension}' "$@"; }\n`);
    const launched = await runtime.execute("subagent", {
      name: "Restricted", agent: "restricted", task: "Report launch state", cwd: runtime.root, autoExit: true,
    });
    const paths = Type.Object({ launchScriptFile: Type.String(), sessionFile: Type.String() });
    assert.ok(Value.Check(paths, launched.details));
    const freshDelivered = runtime.nextMessage();
    execFileSync("bash", [launched.details.launchScriptFile], { env: { ...process.env, BASH_ENV: fakePi } });
    await freshDelivered;
    const first = findLastAssistantMessage(getBranchEntries(launched.details.sessionFile, 0));
    assert.ok(first);
    process.env.PI_CODING_AGENT_DIR = join(runtime.root, "different-config");
    const resumed = await runtime.execute("subagent_resume", {
      sessionPath: launched.details.sessionFile, name: "Restricted resumed", message: "Report resumed state",
    });
    assert.ok(Value.Check(Type.Object({ launchScriptFile: Type.String() }), resumed.details));
    const resumedDelivered = runtime.nextMessage();
    execFileSync("bash", [resumed.details.launchScriptFile], { env: { ...process.env, BASH_ENV: fakePi } });
    await resumedDelivered;
    const last = findLastAssistantMessage(getBranchEntries(launched.details.sessionFile, 0));
    assert.ok(last);
    const Snapshot = Type.Object({
      declaredTools: Type.Array(Type.String()), registeredTools: Type.Array(Type.String()),
      systemPrompt: Type.String(), agentDir: Type.String(), cwd: Type.String(),
    });
    const fresh = Value.Decode(Snapshot, JSON.parse(first));
    const afterResume = Value.Decode(Snapshot, JSON.parse(last));
    const artifacts = join(import.meta.dirname, "artifacts", "resume-restrictions");
    mkdirSync(artifacts, { recursive: true });
    writeFileSync(join(artifacts, "receipt.json"), JSON.stringify({ fresh, afterResume, paidRequests: 0 }, null, 2));
    assert.equal(afterResume.cwd, fresh.cwd);
    assert.deepEqual(afterResume.declaredTools, fresh.declaredTools);
    assert.deepEqual(afterResume.registeredTools, fresh.registeredTools);
    assert.equal(afterResume.agentDir, fresh.agentDir);
    assert.match(afterResume.systemPrompt, /ROLE_INSTRUCTION_FROM_LAUNCH/);
  });

  it("rejects a Pi-only exit override for a Claude CLI launch before creating resources", async (t) => {
    const runtime = lifecycleRuntime();
    t.after(() => runtime.event("session_shutdown", "quit"));
    process.env.ORCA_TEST_SCENARIO = "waiting";
    process.env.PI_SUBAGENT_SHELL_READY_DELAY_MS = "0";
    process.env.PI_CODING_AGENT_DIR = join(runtime.root, "config");
    const agents = join(process.env.PI_CODING_AGENT_DIR, "agents");
    mkdirSync(agents, { recursive: true });
    writeFileSync(join(agents, "claude-cli.md"), "---\nextension: pi-interactive-subagents\ncli: claude\n---\nReturn the answer.\n");
    const before = fileTree(runtime.root);
    await assert.rejects(runtime.execute("subagent", {
      name: "Unsupported policy", task: "Return the answer", cwd: runtime.root,
      agent: "claude-cli", autoExit: false,
    }), /autoExit.*Pi-backed/);
    assert.deepEqual(fileTree(runtime.root), before);
    assert.equal(calls().some((call) => Array.isArray(call) && ["create", "send"].includes(call[1])), false);
  });
});

describe("Named launch membership", () => {
  const cases = [
    { name: "missing", content: null },
    { name: "", content: null },
    { name: "unmarked", content: "---\nname: unmarked\n---\nPrivate" },
    { name: "foreign", content: "---\nextension: other\n---\nPrivate" },
    { name: "list-marker", content: "---\nextension: [pi-interactive-subagents]\n---\nPrivate" },
    { name: "invalid-yaml", content: "---\nextension: pi-interactive-subagents\nbroken: [\n---" },
    { name: "invalid-profile", content: "---\nextension: pi-interactive-subagents\nprofile: private\n---\nPrivate" },
  ];
  for (const fixture of cases) {
    it(`rejects ${JSON.stringify(fixture.name)} before creating child resources`, async (t) => {
      const runtime = lifecycleRuntime();
      const cwd = process.cwd();
      const config = process.env.PI_CODING_AGENT_DIR;
      process.chdir(runtime.root);
      process.env.PI_CODING_AGENT_DIR = join(runtime.root, "config");
      process.env.PI_SUBAGENT_SHELL_READY_DELAY_MS = "0";
      process.env.ORCA_TEST_SCENARIO = "waiting";
      t.after(async () => {
        await runtime.event("session_shutdown", "quit");
        process.chdir(cwd);
        if (config === undefined) delete process.env.PI_CODING_AGENT_DIR;
        else process.env.PI_CODING_AGENT_DIR = config;
      });
      if (fixture.content !== null) {
        const agents = join(runtime.root, ".pi/agents");
        mkdirSync(agents, { recursive: true });
        writeFileSync(join(agents, `${fixture.name}.md`), fixture.content);
      }
      const before = fileTree(runtime.root);
      await assert.rejects(runtime.execute("subagent", { name: "Rejected", task: "Do not start", cwd: runtime.root, agent: fixture.name }),
        (error: Error) => fixture.name.startsWith("invalid")
          ? error.message.includes(join(runtime.root, ".pi/agents", `${fixture.name}.md`))
          : error.message.includes("not found"));
      assert.deepEqual(fileTree(runtime.root), before);
      assert.equal(calls().some((call) => Array.isArray(call) && ["create", "send"].includes(call[1])), false);
      assert.equal(__test__.runningSubagents.size, 0);
      assert.deepEqual(runtime.messages, []);
      const artifacts = join(import.meta.dirname, "artifacts/terminal-lifecycle");
      mkdirSync(artifacts, { recursive: true });
      writeFileSync(join(artifacts, `membership-${fixture.name || "empty"}.json`), JSON.stringify({ name: fixture.name, before, after: fileTree(runtime.root), calls: calls(), paidRequests: 0 }, null, 2));
    });
  }

  it("launches canonical project defaults, rejects a removed prechecked role and still supports bare launch", async (t) => {
    const runtime = lifecycleRuntime();
    const previousCwd = process.cwd();
    const previousConfig = process.env.PI_CODING_AGENT_DIR;
    process.chdir(runtime.root);
    process.env.PI_CODING_AGENT_DIR = join(runtime.root, "config");
    process.env.PI_SUBAGENT_SHELL_READY_DELAY_MS = "0";
    process.env.ORCA_TEST_SCENARIO = "waiting";
    t.after(async () => {
      await runtime.event("session_shutdown", "quit");
      process.chdir(previousCwd);
      if (previousConfig === undefined) delete process.env.PI_CODING_AGENT_DIR;
      else process.env.PI_CODING_AGENT_DIR = previousConfig;
    });
    const globalAgents = join(process.env.PI_CODING_AGENT_DIR, "agents");
    const projectAgents = join(runtime.root, ".pi/agents");
    mkdirSync(globalAgents, { recursive: true });
    mkdirSync(projectAgents, { recursive: true });
    writeFileSync(join(globalAgents, "global-file.md"), "---\nextension: pi-interactive-subagents\nname: selected\nmodel: fixture/global\n---\nGlobal instructions");
    writeFileSync(join(projectAgents, "project-file.md"), '---\nextension: pi-interactive-subagents\nname: selected\nmodel: "fixture/project # literal"\nsystem-prompt: replace\n---\nProject instructions');
    const launched = await runtime.execute("subagent", { name: "Canonical", task: "Wait", agent: "selected", cwd: runtime.root });
    const LaunchPaths = Type.Object({ launchScriptFile: Type.String() });
    assert.ok(Value.Check(LaunchPaths, launched.details));
    const script = readFileSync(launched.details.launchScriptFile, "utf8");
    assert.ok(script.includes("fixture/project # literal"));
    const context = join(runtime.root, "artifacts/parent/context");
    const prompt = readdirSync(context).find(file => file.includes("sysprompt"));
    assert.ok(prompt);
    assert.equal(readFileSync(join(context, prompt), "utf8"), "Project instructions");
    const command = runtime.commands.get("subagent");
    assert.ok(command);
    // SAFETY: A successful command precheck uses only the session-independent definition lookup and queued message API.
    await command.handler("selected Continue", runtime.ctx as ExtensionCommandContext);
    assert.equal(runtime.userMessages.length, 1);
    execFileSync("trash", [join(projectAgents, "project-file.md"), join(globalAgents, "global-file.md")]);
    const before = fileTree(runtime.root);
    const mutationsBefore = calls().filter(call => Array.isArray(call) && ["create", "send"].includes(call[1])).length;
    await assert.rejects(runtime.execute("subagent", { name: "Removed", task: "Wait", agent: "selected", cwd: runtime.root }), /not found/);
    assert.deepEqual(fileTree(runtime.root), before);
    assert.equal(calls().filter(call => Array.isArray(call) && ["create", "send"].includes(call[1])).length, mutationsBefore);
    const bare = await runtime.execute("subagent", { name: "Bare", task: "Wait", cwd: runtime.root });
    assert.match(JSON.stringify(bare.content), /launched/);
    const model = "fixture/model # literal";
    const environment = createTestEnv("orca", model);
    try {
      process.chdir(environment.dir);
      assert.equal(__test__.loadAgentDefaults("test-echo").model, model);
      assert.equal(__test__.loadAgentDefaults("test-ping").model, model);
    } finally {
      process.chdir(runtime.root);
      execFileSync("trash", [environment.dir]);
    }
    const artifacts = join(import.meta.dirname, "artifacts/terminal-lifecycle");
    mkdirSync(artifacts, { recursive: true });
    writeFileSync(join(artifacts, "membership-receipt.json"), JSON.stringify({ canonicalProjectLaunch: true, rejectedStalePrecheck: true, bareLaunch: true, selectedModel: model, calls: calls(), paidRequests: 0 }, null, 2));
  });
});

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
    let shutdown: () => void | Promise<void> = () => {};
    let deliver: (message: Message) => void = () => {};
    const api: Partial<ExtensionAPI> = {
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
    subagentsExtension({ ...api, on(event: string, handler: LifecycleHook) {
      if (event === "session_shutdown") shutdown = () => handler({ type: event, reason: "quit" }, ctx);
    } } as ExtensionAPI);
    t.after(async () => { await shutdown(); });
    process.env.ORCA_TEST_SCENARIO = "closed-unreadable";
    process.env.PI_SUBAGENT_SHELL_READY_DELAY_MS = "0";
    process.env.PI_SUBAGENT_AUTO_EXIT = "1";
    process.env.PI_CODING_AGENT_DIR = join(directory, "agent");
    const agentDir = join(process.env.PI_CODING_AGENT_DIR, "agents");
    mkdirSync(agentDir, { recursive: true });
    writeFileSync(join(agentDir, "lifecycle-claude.md"), "---\nextension: pi-interactive-subagents\ncli: claude\n---\nTest agent.\n");
    writeFileSync(join(agentDir, "lifecycle-interactive.md"), "---\nextension: pi-interactive-subagents\nsystem-prompt: replace\n---\nWait for the user's next request.\n");
    const modelEnv = createTestEnv("orca", "fixture/selected-model");
    const previousCwd = process.cwd();
    process.chdir(modelEnv.dir);
    t.after(() => {
      process.chdir(previousCwd);
      execFileSync("trash", [modelEnv.dir]);
    });
    assert.equal(modelEnv.model, "fixture/selected-model");
    for (const name of ["test-echo", "test-ping"]) {
      assert.equal(__test__.loadAgentDefaults(name)?.model, modelEnv.model);
    }
    startPi("term_parent", modelEnv, "Test the selected model");
    const parentScript = readdirSync(modelEnv.dir).find((name) => name.startsWith("test-launch-"));
    assert.ok(parentScript);
    const parentCommand = readFileSync(join(modelEnv.dir, parentScript), "utf8");
    assert.match(parentCommand, /--model 'fixture\/selected-model'/);
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
      { tool: "subagent", params: { name: "Interactive child", task: "Wait", agent: "lifecycle-interactive", cwd: directory } },
      { tool: "subagent", params: { name: "Selected model child", task: "Wait", agent: "test-echo", cwd: modelEnv.dir } },
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
      if (entry.params.name !== "Claude child") {
        const scriptDir = join(directory, "artifacts", "lifecycle-test", "subagent-scripts");
        const prefix = entry.params.name.toLowerCase().replaceAll(" ", "-") + "-";
        const script = readdirSync(scriptDir).find((name) => name.startsWith(prefix));
        assert.ok(script);
        const command = readFileSync(join(scriptDir, script), "utf8");
        const autoExit = entry.params.name === "Selected model child" ? "1" : "0";
        assert.ok(command.includes(`PI_SUBAGENT_AUTO_EXIT=${autoExit}`));
        if (entry.params.name === "Selected model child") {
          assert.match(command, /'--model' 'fixture\/selected-model'/);
        }
      }
      if (entry.params.name === "Fresh child" || entry.params.name === "Interactive child") {
        const contextDir = join(directory, "artifacts", "lifecycle-test", "context");
        const taskFiles = readdirSync(contextDir).filter((name) => !name.includes("sysprompt"));
        assert.ok(taskFiles.length > 0);
        for (const file of taskFiles) {
          const task = readFileSync(join(contextDir, file), "utf8");
          assert.match(task, /Wait/);
          assert.doesNotMatch(task, /call(?:ing)? (?:the )?subagent_done|Complete your task/);
        }
        if (entry.params.name === "Interactive child") {
          const systemPrompt = readdirSync(contextDir).find((name) => name.includes("sysprompt"));
          assert.ok(systemPrompt);
          assert.equal(readFileSync(join(contextDir, systemPrompt), "utf8"), "Wait for the user's next request.");
        }
      }
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
    writeFileSync(join(artifacts, "receipt.json"), JSON.stringify({ results: receipt, parentCommand, model: modelEnv.model, paidRequests: 0 }, null, 2) + "\n");
    t.diagnostic(`Verification artifact: ${artifacts}/receipt.json`);
  });
});
