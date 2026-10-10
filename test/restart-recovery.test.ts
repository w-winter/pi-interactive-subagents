import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, realpathSync, statSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { setTimeout } from "node:timers/promises";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { ProjectTrustStore, RpcClient } from "/opt/homebrew/lib/node_modules/@earendil-works/pi-coding-agent/dist/index.js";
import { decodeRun, readClaim, readOutcome } from "../pi-extension/subagents/run-records.ts";
import { Type, type Static } from "@sinclair/typebox";
import { Value } from "@sinclair/typebox/value";

const root = fileURLToPath(new URL("../", import.meta.url));
// The private native PTY proof completes within this bound; a missing recovery must fail, not hang.
const FIXTURE_WAIT_MS = 30_000;
const FIXTURE_OBSERVATION_INTERVAL_MS = 20;
const Actor = Type.Object({ pid: Type.Integer({ minimum: 1 }), ppid: Type.Integer({ minimum: 1 }) });
const TerminalActor = Type.Object({ pid: Type.Integer({ minimum: 1 }), runnerPid: Type.Integer({ minimum: 1 }) });
const CommonAck = Type.Object({ id: Type.String(), launchScriptFile: Type.String() });
const Ack = Type.Object({ ...CommonAck.properties, sessionFile: Type.String() });
const ProviderCall = Type.Object({ model: Type.String(), pid: Type.Integer({ minimum: 1 }) });

function json<T extends import("@sinclair/typebox").TSchema>(path: string, schema: T): Static<T> {
  return Value.Decode(schema, JSON.parse(readFileSync(path, "utf8")));
}
async function observeUntil(check: () => Promise<boolean> | boolean, description: string) {
  const deadline = Date.now() + FIXTURE_WAIT_MS;
  while (!(await check())) {
    assert.ok(Date.now() < deadline, description);
    await setTimeout(FIXTURE_OBSERVATION_INTERVAL_MS);
  }
}
function lines(path: string): unknown[] {
  return existsSync(path) ? readFileSync(path, "utf8").split("\n").filter(Boolean).map((line) => JSON.parse(line)) : [];
}

async function latestRun(rpc: RpcClient) {
  const entries = (await rpc.getEntries()).entries;
  const entry = entries.findLast((item) => item.type === "custom" && item.customType === "subagent-run");
  assert.ok(entry && entry.type === "custom");
  return decodeRun(entry.data);
}

async function fixture(claudeInteractive = false, extraEnv: Record<string, string> = {}) {
  const dir = realpathSync(mkdtempSync(join(tmpdir(), "pis-parent-recovery-")));
  const agentDir = join(dir, "config");
  const sessions = join(dir, "sessions");
  const bin = join(dir, "bin"); mkdirSync(bin);
  symlinkSync(join(root, "test/fixtures/recovery-claude.mjs"), join(bin, "claude"));
  writeFileSync(join(bin, "tmux"), '#!/usr/bin/env node\nrequire("node:fs").appendFileSync(process.env.RECOVERY_FIXTURE_ROOT + "/wrong-backend-calls.jsonl", JSON.stringify(process.argv.slice(2)) + "\\n"); process.exit(1);\n', { mode: 0o700 });
  const parentFile = join(sessions, "parent.jsonl");
  mkdirSync(sessions); mkdirSync(join(agentDir, "extensions"), { recursive: true });
  mkdirSync(join(agentDir, "agents"));
  writeFileSync(join(agentDir, "agents", "fixture-claude.md"), "---\nextension: pi-interactive-subagents\ncli: claude\n---\nTest only.\n");
  const provider = join(root, "test/fixtures/recovery-provider.ts");
  symlinkSync(provider, join(agentDir, "extensions/provider.ts"));
  new ProjectTrustStore(agentDir).set(dir, true);
  const providerLog = join(dir, "provider.jsonl");
  const childRelease = join(dir, "release-child");
  const parentRelease = join(dir, "release-parent");
  const env: Record<string, string> = {};
  for (const key of Object.keys(process.env)) if (key.startsWith("PI_SUBAGENT_")) env[key] = "";
  for (const key of ["CMUX_SOCKET_PATH", "TMUX", "TMUX_PANE", "ZELLIJ", "ZELLIJ_SESSION_NAME", "WEZTERM_UNIX_SOCKET", "BASH_ENV", "NODE_OPTIONS", "NODE_REPL_EXTERNAL_MODULE"]) env[key] = "";
  Object.assign(env, {
    PATH: bin + ":" + process.env.PATH, RECOVERY_CLAUDE_HOOK: join(root, "pi-extension/subagents/plugin/hooks/on-stop.sh"), RECOVERY_CLAUDE_INTERACTIVE: claudeInteractive ? "1" : "0",
    HOME: dir, PI_CODING_AGENT_DIR: agentDir, PI_OFFLINE: "1", PI_SUBAGENT_MUX: "orca",
    PI_SUBAGENT_SHELL_READY_DELAY_MS: "0", ORCA_TERMINAL_HANDLE: "fixture-parent",
    ORCA_CLI_COMMAND: join(root, "test/fixtures/recovery-mux.mjs"), RECOVERY_FIXTURE_ROOT: dir,
    RECOVERY_PROVIDER_LOG: providerLog, RECOVERY_CHILD_RELEASE: childRelease,
    RECOVERY_PARENT_RELEASE: parentRelease, RECOVERY_PARENT_FILE: parentFile,
    RECOVERY_LIFECYCLE_LOG: join(dir, "lifecycle.jsonl"), ...extraEnv,
  });
  const options = {
    cliPath: "/opt/homebrew/lib/node_modules/@earendil-works/pi-coding-agent/dist/bundle/cli.js", cwd: dir,
    args: ["--offline", "--no-extensions", "--no-skills", "--no-context-files", "--no-prompt-templates",
      "--session-dir", sessions, "--session", parentFile, "--model", "recovery-test/parent",
      "-e", provider, "-e", join(root, "pi-extension/subagents/index.ts")], env,
  };
  const clients: RpcClient[] = [];
  async function open(file = parentFile, overrides: Record<string, string> = {}, extension = join(root, "pi-extension/subagents/index.ts")) {
    const rpc = new RpcClient({ ...options, args: options.args.map((arg) => arg === parentFile ? file
      : arg === join(root, "pi-extension/subagents/index.ts") ? extension : arg), env: { ...env, ...overrides } });
    clients.push(rpc); await rpc.start(); return rpc;
  }
  function providerCalls() { return lines(providerLog).map((entry) => Value.Decode(ProviderCall, entry)); }
  function launch(rpc: RpcClient, overrides: { agent: "fixture-claude"; autoExit: undefined; resumeSessionId?: string }): Promise<Static<typeof CommonAck>>;
  function launch(rpc: RpcClient, overrides?: { task?: string; autoExit?: boolean; interactive?: boolean }, awaitExecution?: boolean): Promise<Static<typeof Ack>>;
  async function launch(rpc: RpcClient, overrides: { agent?: "fixture-claude"; task?: string; autoExit?: boolean; interactive?: boolean; resumeSessionId?: string } = {}, awaitExecution = true) {
    await rpc.promptAndWait("CALL subagent " + JSON.stringify({ name: "Recovery proof", task: "Return the fixture answer.",
      model: "recovery-test/child", autoExit: true, interactive: true, cwd: dir, ...overrides }));
    const { entries } = await rpc.getEntries();
    const entry = entries.findLast((item) => item.type === "message" && item.message.role === "toolResult" && item.message.toolName === "subagent");
    assert.ok(entry && entry.type === "message" && entry.message.role === "toolResult");
    const ack = overrides.agent ? Value.Decode(CommonAck, entry.message.details) : Value.Decode(Ack, entry.message.details);
    if (overrides.agent) assert.equal("sessionFile" in ack, false, "Claude acknowledgement cannot advertise fabricated Pi history");
    if (awaitExecution) await observeUntil(() => existsSync(overrides.agent ? join(dir, "claude-response-ready") : childRelease + ".waiting"), "native child must reach its provider/hook gate");
    return ack;
  }
  function killParent() {
    const pid = providerCalls().find((call) => call.model === "parent")?.pid;
    assert.ok(pid); process.kill(pid, "SIGKILL");
  }
  async function results(rpc: RpcClient, customType = "subagent_result") {
    const { entries } = await rpc.getEntries();
    return entries.filter((entry) => entry.type === "custom_message" && entry.customType === customType);
  }
  function save<T>(name: string, evidence: T) {
    const artifactDir = join(root, "test/artifacts/restart-recovery", name); mkdirSync(artifactDir, { recursive: true });
    writeFileSync(join(artifactDir, "receipt.json"), JSON.stringify({ sourceHead: execFileSync("git", ["rev-parse", "HEAD"], { cwd: root, encoding: "utf8" }).trim(),
      command: "npm run test:restart-recovery", nodeVersion: process.version,
      piVersion: JSON.parse(readFileSync("/opt/homebrew/lib/node_modules/@earendil-works/pi-coding-agent/package.json", "utf8")).version,
      evidence, paidRequests: 0, realTerminalCliCalls: 0, fixtureWaitMs: FIXTURE_WAIT_MS }, null, 2) + "\n");
    writeFileSync(join(artifactDir, "parent.jsonl"), readFileSync(parentFile));
    writeFileSync(join(artifactDir, "terminal-calls.jsonl"), readFileSync(join(dir, "calls.jsonl")));
    if (existsSync(providerLog)) writeFileSync(join(artifactDir, "provider-calls.jsonl"), readFileSync(providerLog));
    for (const file of ["lifecycle.jsonl", "claude-arguments.json", "wrong-backend-calls.jsonl"]) if (existsSync(join(dir, file))) cpSync(join(dir, file), join(artifactDir, file));
    cpSync(join(dir, "terminals"), join(artifactDir, "terminals"), { recursive: true });
    cpSync(join(sessions), join(artifactDir, "sessions"), { recursive: true });
    if (existsSync(join(agentDir, "sessions"))) cpSync(join(agentDir, "sessions"), join(artifactDir, "child-sessions"), { recursive: true });
    const state = JSON.parse(readFileSync(parentFile, "utf8").split("\n")[0]);
    const runDir = join(sessions, "artifacts", state.id);
    if (existsSync(runDir)) cpSync(runDir, join(artifactDir, "run-artifacts"), { recursive: true });
    if (existsSync(join(dir, "claude-transcript.jsonl"))) cpSync(join(dir, "claude-transcript.jsonl"), join(artifactDir, "claude-transcript.jsonl"));
  }
  // oxlint-disable-next-line sonarjs/cognitive-complexity -- Cleanup covers both private process-group and PTY-owner lifetimes, ignoring only already-gone actors.
  async function cleanup() {
    writeFileSync(childRelease, "release"); writeFileSync(parentRelease, "release");
    for (const rpc of clients) await rpc.stop();
    if (existsSync(join(dir, "terminals"))) {
      for (const name of readdirSync(join(dir, "terminals")).filter((file) => file.endsWith(".json"))) {
        const actor = json(join(dir, "terminals", name), TerminalActor);
        try { process.kill(-actor.pid, "SIGKILL"); } catch (error) { if (!(error instanceof Error && "code" in error && error.code === "ESRCH")) throw error; }
        try { process.kill(actor.runnerPid, "SIGTERM"); } catch (error) { if (!(error instanceof Error && "code" in error && error.code === "ESRCH")) throw error; }
      }
    }
    execFileSync("trash", [dir]);
  }
  return { dir, parentFile, childRelease, parentRelease, providerCalls, open, launch, killParent, results, save, cleanup };
}

test("native parent restart reconnects the same child, guards resume, and records its answer once", async () => {
  const f = await fixture();
  try {
    const first = await f.open(); const ack = await f.launch(first);
    const actor = json(f.childRelease + ".waiting", Actor);
    const run = await latestRun(first); const claim = readClaim(run);
    const alias = join(f.dir, "child-alias.jsonl"); symlinkSync(ack.sessionFile, alias);
    f.killParent(); await first.stop();
    const next = await f.open();
    await next.promptAndWait("CALL subagent_resume " + JSON.stringify({ sessionPath: alias }));
    const { entries } = await next.getEntries();
    const resumed = entries.findLast((entry) => entry.type === "message" && entry.message.role === "toolResult" && entry.message.toolName === "subagent_resume");
    assert.ok(resumed && resumed.type === "message" && resumed.message.role === "toolResult");
    assert.match(JSON.stringify(resumed.message), /already running|still running|unavailable/);
    assert.doesNotThrow(() => process.kill(actor.pid, 0), "the original child must still be alive");
    assert.deepEqual(readClaim(run), claim, "reattachment must preserve both recorded start identities");
    writeFileSync(f.childRelease, "release");
    await observeUntil(async () => (await f.results(next)).length === 1, "reattached child result must be durably recorded");
    const recorded = await f.results(next); assert.match(JSON.stringify(recorded), /RECOVERY_CHILD_ANSWER/);
    await next.stop(); const again = await f.open();
    assert.equal((await f.results(again)).length, 1);
    assert.equal(f.providerCalls().filter((call) => call.model === "child").length, 1, "recovery must not request another child answer");
    f.save("surviving-child", { actor, claim, aliasRejected: true, ack, results: await f.results(again) });
  } finally { await f.cleanup(); }
});

test("a child finishing while its parent is absent is recovered without a startup turn or repeated terminal mutations", async () => {
  const f = await fixture();
  try {
    const first = await f.open(); const ack = await f.launch(first);
    const run = await latestRun(first);
    f.killParent(); await first.stop(); writeFileSync(f.childRelease, "release");
    await observeUntil(() => readFileSync(ack.sessionFile, "utf8").includes("RECOVERY_CHILD_ANSWER"), "native child answer must persist");
    const actor = json(f.childRelease + ".waiting", Actor);
    await observeUntil(() => { try { process.kill(actor.pid, 0); return false; } catch (error) { if (error instanceof Error && "code" in error && error.code === "ESRCH") return true; throw error; } }, "child must finish before reopening");
    const before = f.providerCalls().filter((call) => call.model === "parent").length;
    const terminalCallsBefore = lines(join(f.dir, "calls.jsonl")).length;
    const next = await f.open();
    await observeUntil(async () => (await f.results(next)).length === 1, "answer completed while absent must be recovered");
    assert.equal(f.providerCalls().filter((call) => call.model === "parent").length, before);
    const result = await f.results(next); assert.match(JSON.stringify(result), /RECOVERY_CHILD_ANSWER/);
    assert.equal(statSync(run.runDir).mode & 0o777, 0o700);
    for (const file of ["process.json", "completion.json"]) assert.equal(statSync(join(run.runDir, file)).mode & 0o777, 0o600);
    await next.stop(); const again = await f.open(); assert.equal((await f.results(again)).length, 1);
    assert.equal(lines(join(f.dir, "calls.jsonl")).length, terminalCallsBefore);
    f.save("absent-parent", { ack, results: await f.results(again), startupModelRequests: 0, runDirectoryMode: "0700", factModes: "0600" });
  } finally { await f.cleanup(); }
});

test("dispatch is journaled before the real command and an explicit rejected resume can be retried", async () => {
  const f = await fixture();
  try {
    const parent = await f.open(); const ack = await f.launch(parent);
    const dispatch = Value.Decode(Type.Array(Type.Object({ parentEntries: Type.String() })), lines(join(f.dir, "dispatch.jsonl")));
    assert.match(dispatch[0].parentEntries, /subagent-run/, "native ownership must persist before terminal dispatch");
    writeFileSync(f.childRelease, "release");
    await observeUntil(async () => (await f.results(parent)).length === 1, "first child must complete");
    writeFileSync(join(f.dir, "reject"), "reject");
    await parent.promptAndWait("CALL subagent_resume " + JSON.stringify({ sessionPath: ack.sessionFile }));
    execFileSync("trash", [join(f.dir, "reject")]);
    await parent.promptAndWait("CALL subagent_resume " + JSON.stringify({ sessionPath: ack.sessionFile }));
    const { entries } = await parent.getEntries();
    const retried = entries.findLast((entry) => entry.type === "message" && entry.message.role === "toolResult" && entry.message.toolName === "subagent_resume");
    assert.ok(retried && retried.type === "message" && retried.message.role === "toolResult");
    assert.match(JSON.stringify(retried.message), /resumed/);
    f.save("journal-and-retry", { ack, dispatch });
  } finally { await f.cleanup(); }
});

test("queued native delivery survives reload, then parent death, without a duplicate recorded result", async () => {
  const f = await fixture();
  try {
    const parent = await f.open(); const ack = await f.launch(parent);
    await parent.prompt("BLOCK");
    await observeUntil(() => existsSync(f.parentRelease + ".waiting"), "parent must be streaming before child completes");
    writeFileSync(f.childRelease, "release");
    await observeUntil(() => parent.getStderr().includes('"event":"submitted"'), "native completion must have been submitted");
    assert.equal((await f.results(parent)).length, 0, "queued steer is not a disk receipt");
    assert.equal(await parent.prompt("/recovery-reload"), "handled");
    assert.equal((await f.results(parent)).length, 0);
    f.killParent(); await parent.stop();
    const next = await f.open();
    await observeUntil(async () => (await f.results(next)).length === 1, "queued result must be recovered once");
    await next.stop(); const again = await f.open(); assert.equal((await f.results(again)).length, 1);
    f.save("queued-reload-death", { ack, results: await f.results(again) });
  } finally { await f.cleanup(); }
});

test("orderly replacement preserves original parent ownership, and quit is observed before restart", async () => {
  const f = await fixture();
  try {
    const parent = await f.open(); const ack = await f.launch(parent);
    const switched = await parent.clone(); assert.equal(switched.cancelled, false);
    writeFileSync(f.childRelease, "release");
    await observeUntil(() => readFileSync(ack.sessionFile, "utf8").includes("RECOVERY_CHILD_ANSWER"), "child must finish for original parent");
    assert.equal((await f.results(parent)).length, 0, "another session cannot adopt the run");
    await parent.switchSession(f.parentFile);
    await observeUntil(async () => (await f.results(parent)).length === 1, "original parent must recover its child");
    await parent.stop();
    assert.match(parent.getStderr(), /"reason":"fork".*"detachedChildren":1/);
    const again = await f.open(); assert.equal((await f.results(again)).length, 1);
    f.save("original-owner", { ack, results: await f.results(again) });
  } finally { await f.cleanup(); }
});

test("lost real child producers become interruption rather than completion or automatic replay", async () => {
  const f = await fixture();
  try {
    const parent = await f.open(); const ack = await f.launch(parent);
    const run = await latestRun(parent); assert.ok(run.launch.kind !== "claude" && run.launch.activityFile);
    const activityFile = run.launch.activityFile;
    const activity = JSON.parse(readFileSync(activityFile, "utf8")); assert.equal(activity.phase, "active");
    f.killParent(); await parent.stop();
    const actors = readdirSync(join(f.dir, "terminals")).filter((file) => file.endsWith(".json")).map((name) => json(join(f.dir, "terminals", name), TerminalActor));
    assert.equal(actors.length, 1); process.kill(-actors[0].pid, "SIGKILL");
    assert.equal(JSON.parse(readFileSync(activityFile, "utf8")).phase, "active", "stale active status is not evidence that producers survived");
    const next = await f.open();
    await observeUntil(async () => (await f.results(next)).length === 1, "confirmed actor loss must report interruption");
    const outcome = await f.results(next); assert.match(JSON.stringify(outcome), /interrupted/);
    const count = f.providerCalls().filter((call) => call.model === "child").length;
    await next.stop(); const again = await f.open(); assert.equal((await f.results(again)).length, 1);
    assert.equal(f.providerCalls().filter((call) => call.model === "child").length, count);
    f.save("lost-producers", { ack, staleActivity: activity, results: outcome, childRequests: count });
  } finally { await f.cleanup(); }
});

for (const interactive of [false, true]) {
  test(`Claude's real hook retains ${interactive ? "interactive closure" : "autonomous completion"} while parent is absent`, async () => {
    const f = await fixture(interactive);
    try {
      const parent = await f.open();
      const ack = await f.launch(parent, { agent: "fixture-claude", autoExit: undefined });
      f.killParent(); await parent.stop();
      if (interactive) {
        const actorName = readdirSync(join(f.dir, "terminals")).find((name) => name.endsWith(".json"));
        assert.ok(actorName); const actor = json(join(f.dir, "terminals", actorName), TerminalActor);
        process.kill(-actor.pid, "SIGKILL");
      }
      const next = await f.open();
      await observeUntil(async () => (await f.results(next)).length === 1, "Claude captured response must recover");
      const results = await f.results(next); assert.match(JSON.stringify(results), /CLAUDE_RECOVERY_ANSWER/);
      if (interactive) assert.match(JSON.stringify(results), /interrupted/);
      await next.stop(); const again = await f.open(); assert.equal((await f.results(again)).length, 1);
      f.save(interactive ? "claude-interactive" : "claude-autonomous", { ack, results });
    } finally { await f.cleanup(); }
  });
}

test("clearing a live custom queue retains the outcome for reopen without unsafe same-generation resubmission", async () => {
  const f = await fixture();
  try {
    const parent = await f.open(); const ack = await f.launch(parent);
    await parent.prompt("BLOCK"); await observeUntil(() => existsSync(f.parentRelease + ".waiting"), "held parent must start");
    writeFileSync(f.childRelease, "release");
    await observeUntil(() => parent.getStderr().includes('"event":"submitted"'), "child result must be queued");
    await parent.clearQueue(); await parent.abort();
    assert.equal((await f.results(parent)).length, 0);
    assert.equal(parent.getStderr().split('"event":"submitted"').length - 1, 1);
    await parent.stop(); const next = await f.open();
    await observeUntil(async () => (await f.results(next)).length === 1, "reopened runtime must recover the retained result");
    f.save("cleared-queue", { ack, results: await f.results(next) });
  } finally { await f.cleanup(); }
});

test("reopening cancels an unclaimed intent and its delayed script cannot execute or produce a shell result", async () => {
  const f = await fixture();
  try {
    writeFileSync(join(f.dir, "hold-dispatch"), "hold");
    const parent = await f.open(); const ack = await f.launch(parent, {}, false);
    f.killParent(); await parent.stop();
    const next = await f.open();
    await observeUntil(async () => (await f.results(next)).length === 1, "cancelled intent must be reported once");
    const pending = Value.Decode(Type.Array(Type.Object({ command: Type.String() })), lines(join(f.dir, "pending-command.jsonl")));
    execFileSync("/bin/bash", ["-c", pending[0].command], { encoding: "utf8" });
    assert.equal(existsSync(f.childRelease + ".waiting"), false, "cancelled script must not reach the native CLI");
    assert.equal(f.providerCalls().some((call) => call.model === "child"), false);
    assert.equal((await f.results(next)).length, 1);
    await next.stop(); const again = await f.open(); assert.equal((await f.results(again)).length, 1);
    f.save("cancelled-before-start", { ack, results: await f.results(again) });
  } finally { await f.cleanup(); }
});

test("recorded results on an abandoned parent branch are not redelivered", async () => {
  const f = await fixture();
  try {
    const parent = await f.open(); const ack = await f.launch(parent);
    const { entries } = await parent.getEntries();
    const before = entries.findLast((entry) => entry.type === "message" && entry.message.role === "assistant"); assert.ok(before);
    writeFileSync(f.childRelease, "release");
    await observeUntil(async () => (await f.results(parent)).length === 1, "original result must be recorded");
    assert.equal(await parent.prompt("/recovery-select " + before.id), "handled");
    await parent.setSessionName("Before child receipt"); await parent.stop();
    const next = await f.open();
    assert.equal((await f.results(next)).length, 1, "raw recorded result still exists exactly once");
    assert.equal(f.providerCalls().filter((call) => call.model === "child").length, 1);
    f.save("abandoned-parent-receipt", { ack, results: await f.results(next) });
  } finally { await f.cleanup(); }
});

test("recovered children expose no interrupt capability while normal reload retains the original pane", async () => {
  const f = await fixture();
  try {
    const parent = await f.open(); const ack = await f.launch(parent);
    assert.equal(await parent.prompt("/recovery-reload"), "handled");
    await parent.promptAndWait("CALL subagent_interrupt " + JSON.stringify({ id: ack.id }));
    const retained = (await parent.getEntries()).entries.findLast((entry) => entry.type === "message" && entry.message.role === "toolResult" && entry.message.toolName === "subagent_interrupt");
    assert.ok(retained); assert.match(JSON.stringify(retained), /Interrupt requested/);
    const terminalCalls = lines(join(f.dir, "calls.jsonl"));
    assert.deepEqual(terminalCalls.filter((args) => Array.isArray(args) && args.includes("\u001b")),
      [["terminal", "send", "--terminal", "fixture-child-1", "--text", "\u001b", "--json"]]);
    f.killParent(); await parent.stop(); const next = await f.open();
    const before = lines(join(f.dir, "calls.jsonl")).length;
    await next.promptAndWait("CALL subagent_interrupt " + JSON.stringify({ id: ack.id }));
    const entries = (await next.getEntries()).entries;
    const result = entries.findLast((entry) => entry.type === "message" && entry.message.role === "toolResult" && entry.message.toolName === "subagent_interrupt");
    assert.ok(result); assert.match(JSON.stringify(result), /original pane|no terminal controls/);
    assert.equal(lines(join(f.dir, "calls.jsonl")).length, before, "recovered interrupt must not call any terminal CLI");
    f.save("interrupt-capability", { ack, results: result });
  } finally { await f.cleanup(); }
});

test("corrupt process facts prevent an overlapping resume without discarding the still-running child", async () => {
  const f = await fixture();
  try {
    const parent = await f.open(); const ack = await f.launch(parent); const run = await latestRun(parent);
    const actor = json(f.childRelease + ".waiting", Actor);
    writeFileSync(join(run.runDir, "process.json"), JSON.stringify({ kind: "claimed", id: "another-execution" }));
    await parent.promptAndWait("CALL subagent_resume " + JSON.stringify({ sessionPath: ack.sessionFile }));
    const entries = (await parent.getEntries()).entries;
    const result = entries.findLast((entry) => entry.type === "message" && entry.message.role === "toolResult" && entry.message.toolName === "subagent_resume");
    assert.ok(result); assert.match(JSON.stringify(result), /Invalid subagent|Wrong subagent/);
    assert.equal(f.providerCalls().filter((call) => call.model === "child").length, 1);
    assert.doesNotThrow(() => process.kill(actor.pid, 0));
    assert.equal((await f.results(parent)).length, 0);
    f.save("corrupt-identity", { ack, result });
  } finally { await f.cleanup(); }
});

test("failed child publication leaves its native session alive instead of claiming completion", async () => {
  const f = await fixture();
  try {
    const parent = await f.open(); const ack = await f.launch(parent); const run = await latestRun(parent);
    assert.notEqual(run.launch.kind, "claude");
    mkdirSync(join(run.runDir, "completion.json"));
    writeFileSync(f.childRelease, "release");
    assert.ok(run.launch.kind !== "claude" && run.launch.stderrFile);
    await observeUntil(() => readFileSync(run.launch.kind === "claude" ? "" : run.launch.stderrFile ?? "", "utf8").includes("publication_failed"), "native child must report publication failure");
    const actor = json(f.childRelease + ".waiting", Actor);
    assert.doesNotThrow(() => process.kill(actor.pid, 0), "unpublished result must leave native child open");
    assert.equal((await f.results(parent)).length, 0);
    f.save("publication-failure", { ack, actor, outcomeClaimed: false });
  } finally { await f.cleanup(); }
});

test("a frozen child outcome survives later native history mutation and an orderly parent quit", async () => {
  const f = await fixture();
  try {
    const parent = await f.open(); const ack = await f.launch(parent);
    await parent.stop();
    assert.match(parent.getStderr(), /"reason":"quit".*"detachedChildren":1/);
    const parentPid = f.providerCalls().find((call) => call.model === "parent")?.pid;
    const lifecycle = Value.Decode(Type.Array(Type.Object({ pid: Type.Number(), event: Type.String() })), lines(join(f.dir, "lifecycle.jsonl"))).filter((entry) => entry.pid === parentPid);
    assert.deepEqual(lifecycle.map((entry) => entry.event), ["detached", "exit"], "quit must detach before orderly process exit, not SIGKILL escalation");
    writeFileSync(f.childRelease, "release");
    const actor = json(f.childRelease + ".waiting", Actor);
    await observeUntil(() => { try { process.kill(actor.pid, 0); return false; } catch (error) { if (error instanceof Error && "code" in error && error.code === "ESRCH") return true; throw error; } }, "child must finish before another native writer");
    const writer = new RpcClient({
      cliPath: "/opt/homebrew/lib/node_modules/@earendil-works/pi-coding-agent/dist/bundle/cli.js", cwd: f.dir,
      args: ["--offline", "--no-extensions", "--no-skills", "--no-context-files", "--no-prompt-templates", "--no-tools",
        "--session", ack.sessionFile, "--model", "guard-test/sol", "-e", join(root, "test/fixtures/model-guard-provider.ts")],
      env: { HOME: f.dir, PI_CODING_AGENT_DIR: join(f.dir, "writer-config"), PI_SUBAGENT_SESSION: "", PI_SUBAGENT_RUN: "", PI_SUBAGENT_ID: "", PI_SUBAGENT_AUTO_EXIT: "0" },
    });
    try { await writer.start(); await writer.promptAndWait("Later child history"); } finally { await writer.stop(); }
    const next = await f.open();
    await observeUntil(async () => (await f.results(next)).length === 1, "frozen result must recover");
    const results = await f.results(next); assert.match(JSON.stringify(results), /RECOVERY_CHILD_ANSWER/);
    assert.doesNotMatch(JSON.stringify(results), /"model":"sol"/);
    f.save("frozen-after-mutation", { ack, results });
  } finally { await f.cleanup(); }
});

test("loading recovery after the baseline global layout permits a native launch", async () => {
  const f = await fixture(false, { RECOVERY_SEED_HEAD_STATE: "1" });
  try {
    const parent = await f.open(); const ack = await f.launch(parent);
    writeFileSync(f.childRelease, "release");
    await observeUntil(async () => (await f.results(parent)).length === 1, "new generation must initialize independently of HEAD state");
    f.save("baseline-layout", { ack, results: await f.results(parent) });
  } finally { await f.cleanup(); }
});

test("reload drains one queued submission exactly once within the same native runtime", async () => {
  const f = await fixture();
  try {
    const parent = await f.open(); const ack = await f.launch(parent);
    await parent.prompt("BLOCK");
    await observeUntil(() => existsSync(f.parentRelease + ".waiting"), "parent must reach its held stream");
    writeFileSync(f.childRelease, "release");
    await observeUntil(() => parent.getStderr().includes('"event":"submitted"'), "child must queue one submission");
    assert.equal(await parent.prompt("/recovery-reload"), "handled");
    writeFileSync(f.parentRelease, "release");
    await observeUntil(async () => (await f.results(parent)).length === 1, "reloaded queue must drain without restart");
    await parent.promptAndWait("Confirm queue drained");
    assert.equal((await f.results(parent)).length, 1);
    assert.equal(parent.getStderr().split('"event":"submitted"').length - 1, 1);
    f.save("reload-drained", { ack, submissions: 1, results: await f.results(parent) });
  } finally { await f.cleanup(); }
});

test("a copied parent header does not adopt the original file's execution", async () => {
  const f = await fixture();
  try {
    const parent = await f.open(); const ack = await f.launch(parent); const run = await latestRun(parent);
    f.killParent(); await parent.stop();
    const copy = join(f.dir, "sessions/copied-parent.jsonl"); cpSync(f.parentFile, copy);
    const copied = await f.open(copy);
    await copied.promptAndWait("Copied history only");
    writeFileSync(f.childRelease, "release");
    await observeUntil(() => readOutcome(run) !== null, "child outcome must exist while copied history is open");
    assert.equal((await f.results(copied)).length, 0);
    await copied.stop(); const original = await f.open();
    await observeUntil(async () => (await f.results(original)).length === 1, "original file must recover its own result");
    f.save("copied-owner", { ack, copy, originalResults: await f.results(original) });
  } finally { await f.cleanup(); }
});

test("recovery with status disabled and a different available backend never mutates a terminal", async () => {
  const f = await fixture();
  try {
    const parent = await f.open(); const ack = await f.launch(parent);
    f.killParent(); await parent.stop();
    const copy = join(f.dir, "disabled-package"); mkdirSync(join(copy, "pi-extension"), { recursive: true });
    cpSync(join(root, "pi-extension/subagents"), join(copy, "pi-extension/subagents"), { recursive: true });
    symlinkSync(join(root, "node_modules"), join(copy, "node_modules"));
    writeFileSync(join(copy, "config.json"), JSON.stringify({ status: { enabled: false } }));
    const before = lines(join(f.dir, "calls.jsonl")).length;
    const next = await f.open(f.parentFile, { PI_SUBAGENT_MUX: "tmux", TMUX: "/fixture/tmux,1,0" }, join(copy, "pi-extension/subagents/index.ts"));
    writeFileSync(f.childRelease, "release");
    await observeUntil(async () => (await f.results(next)).length === 1, "disabled status must not disable recovery");
    assert.equal(lines(join(f.dir, "calls.jsonl")).length, before);
    const capabilityQueries = lines(join(f.dir, "wrong-backend-calls.jsonl"));
    for (const call of capabilityQueries) assert.deepEqual(call, ["display-message", "-p", "#{client_termfeatures}"], "only native terminal capability detection may query the fake backend");
    f.save("disabled-backend", { ack, statusEnabled: false, currentBackend: "tmux", terminalMutations: 0, capabilityQueries, results: await f.results(next) });
  } finally { await f.cleanup(); }
});

test("an ambiguous transport failure after the claim keeps the original native execution", async () => {
  const f = await fixture();
  try {
    writeFileSync(join(f.dir, "ambiguous-send"), "fail after claim");
    const parent = await f.open(); const ack = await f.launch(parent);
    assert.match(parent.getStderr(), /confirmation_incomplete/);
    writeFileSync(f.childRelease, "release");
    await observeUntil(async () => (await f.results(parent)).length === 1, "claimed execution must remain observed despite transport error");
    assert.equal(f.providerCalls().filter((call) => call.model === "child").length, 1);
    f.save("ambiguous-claimed", { ack, results: await f.results(parent) });
  } finally { await f.cleanup(); }
});

for (const ping of [false, true]) {
  for (const blocked of [false, true]) {
    test(`explicit ${ping ? "ping" : "done"} ${blocked ? "publication failure leaves its native child open" : "produces a retained outcome and native receipt"}`, async () => {
      const f = await fixture();
      try {
        const parent = await f.open();
        const ack = await f.launch(parent, { autoExit: false, task: ping ? "RECOVERY_EXPLICIT_PING" : "RECOVERY_EXPLICIT_DONE" });
        const run = await latestRun(parent);
        if (blocked) mkdirSync(join(run.runDir, "completion.json"));
        writeFileSync(f.childRelease, "release");
        if (blocked) {
          await observeUntil(() => readFileSync(ack.sessionFile, "utf8").includes('"isError":true'), "explicit publication must report tool failure");
          const actor = json(f.childRelease + ".waiting", Actor);
          assert.doesNotThrow(() => process.kill(actor.pid, 0));
          assert.equal((await f.results(parent, ping ? "subagent_ping" : "subagent_result")).length, 0);
          f.save(ping ? "ping-publication-failure" : "done-publication-failure", { ack, actor, remainsOpen: true });
          return;
        }
        await observeUntil(async () => (await f.results(parent, ping ? "subagent_ping" : "subagent_result")).length === 1, "explicit outcome must reach native parent history");
        const results = await f.results(parent, ping ? "subagent_ping" : "subagent_result");
        assert.match(JSON.stringify(results), ping ? /RECOVERY_HELP_REQUEST/ : /RECOVERY_EXPLICIT_ANSWER/);
        assert.equal(readOutcome(run)?.reason, ping ? "ping" : "done");
        f.save(ping ? "explicit-ping" : "explicit-done", { ack, results });
      } finally { await f.cleanup(); }
    });
  }
}

test("native child quit publishes a retained quit outcome rather than interruption", async () => {
  const f = await fixture();
  try {
    const parent = await f.open(); const ack = await f.launch(parent, { autoExit: false });
    const run = await latestRun(parent); const actor = json(f.childRelease + ".waiting", Actor);
    process.kill(actor.pid, "SIGTERM");
    await observeUntil(async () => (await f.results(parent)).length === 1, "orderly child quit must notify parent");
    assert.equal(readOutcome(run)?.reason, "quit");
    f.save("child-quit", { ack, results: await f.results(parent) });
  } finally { await f.cleanup(); }
});

test("resumed executions finishing while absent never return an earlier answer", async () => {
  const f = await fixture();
  try {
    const parent = await f.open(); const ack = await f.launch(parent);
    const firstActor = json(f.childRelease + ".waiting", Actor);
    writeFileSync(f.childRelease, "release");
    await observeUntil(async () => (await f.results(parent)).length === 1, "initial answer must be recorded");
    await observeUntil(() => { try { process.kill(firstActor.pid, 0); return false; } catch (error) { if (error instanceof Error && "code" in error && error.code === "ESRCH") return true; throw error; } }, "initial child must exit before explicit resume");
    execFileSync("trash", [f.childRelease]);
    await parent.promptAndWait("CALL subagent_resume " + JSON.stringify({ sessionPath: ack.sessionFile, message: "RECOVERY_NO_ANSWER" }));
    await observeUntil(() => json(f.childRelease + ".waiting", Actor).pid !== firstActor.pid, "resumed execution must reach provider gate");
    const run = await latestRun(parent); assert.equal(run.launch.kind, "pi-resume");
    f.killParent(); await parent.stop(); writeFileSync(f.childRelease, "release");
    await observeUntil(() => readOutcome(run) !== null, "resumed semantic outcome must persist while parent is absent");
    const before = f.providerCalls().filter((call) => call.model === "parent").length;
    const next = await f.open();
    await observeUntil(async () => (await f.results(next)).length === 2, "resumed result must recover exactly once");
    const result = (await f.results(next)).at(-1);
    assert.doesNotMatch(JSON.stringify(result), /RECOVERY_CHILD_ANSWER/);
    assert.equal(f.providerCalls().filter((call) => call.model === "parent").length, before);
    f.save("resumed-absent", { ack, run, result });
  } finally { await f.cleanup(); }
});

test("Claude resume arguments and captured text survive transcript-copy failure", async () => {
  const f = await fixture();
  try {
    const parent = await f.open();
    const ack = await f.launch(parent, { agent: "fixture-claude", autoExit: undefined, resumeSessionId: "fixture-existing-session" });
    const run = await latestRun(parent); const outcome = readOutcome(run);
    assert.ok(outcome && "output" in outcome && outcome.output.cli === "claude" && outcome.output.transcriptPath);
    const args = Value.Decode(Type.Array(Type.String()), JSON.parse(readFileSync(join(f.dir, "claude-arguments.json"), "utf8")));
    assert.equal(args[args.indexOf("--resume") + 1], "fixture-existing-session");
    f.killParent(); await parent.stop(); execFileSync("trash", [outcome.output.transcriptPath]);
    const next = await f.open();
    await observeUntil(async () => (await f.results(next)).length === 1, "copy failure must preserve the captured answer");
    assert.match(JSON.stringify(await f.results(next)), /CLAUDE_RECOVERY_ANSWER/);
    assert.match(next.getStderr(), /transcript_copy_failed/);
    assert.deepEqual(readOutcome(run), outcome);
    f.save("claude-copy-failure", { ack, args, outcome, results: await f.results(next) });
  } finally { await f.cleanup(); }
});
