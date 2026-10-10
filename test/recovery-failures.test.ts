import assert from "node:assert/strict";
import childProcess, { execFileSync, spawnSync, type ExecFileSyncOptions } from "node:child_process";
import { appendFileSync, chmodSync, existsSync, mkdtempSync, readFileSync, realpathSync, statSync, writeFileSync } from "node:fs";
import { syncBuiltinESMExports } from "node:module";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test, { type TestContext } from "node:test";
import type { ExtensionContext } from "@mariozechner/pi-coding-agent";
import { buildRunCommand } from "../pi-extension/subagents/launch-command.ts";
import { observeRun, pollForExit } from "../pi-extension/subagents/completion.ts";
import { ParentRunObserver, type ParentRunState, type RecoveredChild } from "../pi-extension/subagents/recovery.ts";
import { cancelUnstarted, captureShellOutcome, decodeRun, observeActor, publishOutcome, publishProcessClaim,
  readOutcome, type RunOutcome } from "../pi-extension/subagents/run-records.ts";

function fixture(t: TestContext) {
  const dir = realpathSync(mkdtempSync(join(tmpdir(), "pis-recovery-boundary-")));
  t.after(() => execFileSync("trash", [dir]));
  const parent = join(dir, "parent.jsonl");
  const record = decodeRun({ id: "boundary", name: "Boundary", task: "", agent: null,
    startTime: Date.now(), interactive: true, owner: { sessionId: "parent", sessionFile: parent }, runDir: dir,
    launch: { kind: "pi-resume", sessionFile: join(dir, "child.jsonl"), activityFile: null, stderrFile: null,
      autoExit: false, entryCountBefore: 2 } });
  writeFileSync(parent, JSON.stringify({ type: "session", version: 3, id: "parent", cwd: dir }) + "\n");
  const actor = { pid: process.pid, started: execFileSync("/bin/ps", ["-p", String(process.pid), "-o", "lstart="],
    { encoding: "utf8", env: { ...process.env, LC_ALL: "C", TZ: "UTC" } }).trim() };
  const gone = { pid: spawnSync("/usr/bin/true").pid, started: "reaped-fixture" };
  const outcome: RunOutcome = { id: record.id, recordedAt: Date.now(), reason: "done", output: { cli: "pi", text: "Frozen answer" } };
  const state: ParentRunState<RecoveredChild> = { agents: new Map(), records: new Map(), submitted: new Set(), owner: null };
  const messages: { options: unknown; outcome: unknown }[] = [];
  function observer() {
    return new ParentRunObserver({
      appendEntry(customType, data) { appendFileSync(parent, JSON.stringify({ type: "custom", id: "launch", customType, data }) + "\n"); },
      sendMessage(message, options) { messages.push({ options, outcome: message }); },
    }, state, { restore: (record) => ({ record, control: "recovered" }),
      message: (_running, outcome) => ({ customType: "subagent_result", content: JSON.stringify(outcome), display: true }),
      update() {}, cleanup() {}, operatorClosed: () => null });
  }
  // SAFETY: The double implements the methods start uses to read session identity; no live Pi UI is invoked.
  const ctx = { sessionManager: { getSessionFile: () => parent, getSessionId: () => "parent" } } as ExtensionContext;
  function journal() { appendFileSync(parent, JSON.stringify({ type: "custom", id: "launch", customType: "subagent-run", data: record }) + "\n"); }
  return { dir, parent, record, actor, gone, outcome, state, messages, observer, ctx, journal };
}

function mockPs(t: TestContext, query: (args: readonly string[]) => string) {
  const original = childProcess.execFileSync;
  t.mock.method(childProcess, "execFileSync", (file: string, args: readonly string[], options: ExecFileSyncOptions | undefined) => {
    if (file === "/bin/ps") return query(args);
    return original(file, args, options);
  });
  syncBuiltinESMExports();
  t.after(() => { t.mock.restoreAll(); syncBuiltinESMExports(); });
}

test("failed reconstruction is not accepted as a complete reload projection", async (t) => {
  const f = fixture(t); f.journal();
  publishProcessClaim(f.record, { kind: "claimed", id: f.record.id, executor: f.actor, supervisor: f.actor });
  const valid = readFileSync(f.parent, "utf8");
  writeFileSync(f.parent, valid + JSON.stringify({ type: "custom", id: "corrupt", customType: "subagent-run", data: { owner: f.record.owner } }) + "\n");
  const first = f.observer(); await assert.rejects(first.start(f.ctx, "startup"), /Invalid subagent/);
  await first.detach("reload");
  writeFileSync(f.parent, valid);
  const next = f.observer(); t.after(() => next.detach("quit"));
  await next.start(f.ctx, "reload");
  assert.match(next.resolveResumeAvailability(f.record.launch.kind === "claude" ? "" : f.record.launch.sessionFile) ?? "", /already running/);
});

test("stale linked launcher temporaries cannot alter a winner or publish a losing receipt", (t) => {
  const f = fixture(t);
  publishProcessClaim(f.record, { kind: "claimed", id: f.record.id, executor: f.actor, supervisor: f.actor });
  const before = readFileSync(join(f.dir, "process.json"), "utf8");
  const command = buildRunCommand({ id: f.record.id, runDir: f.dir, cwd: f.dir, execCommand: "exec /usr/bin/touch duplicate-executed" });
  execFileSync("/bin/bash", ["-c", `ln '${f.dir}/process.json' '${f.dir}/.claim.'$$\n${command}`]);
  assert.equal(readFileSync(join(f.dir, "process.json"), "utf8"), before);
  assert.equal(existsSync(join(f.dir, "shell-exit.json")), false);
  assert.equal(existsSync(join(f.dir, "duplicate-executed")), false);
});

test("an unavailable process query does not strand a later valid completion", async (t) => {
  const f = fixture(t); publishProcessClaim(f.record, { kind: "claimed", id: f.record.id, executor: f.actor, supervisor: f.actor });
  let queries = 0;
  mockPs(t, () => { queries++; throw new Error("Fixture process service unavailable"); });
  const result = await pollForExit(f.record, new AbortController().signal, { interval: 1, operatorClosed: null, onUnavailable() {}, claimMissing: null,
    onTick: () => { publishOutcome(f.record, f.outcome); } });
  assert.equal(queries, 1); assert.ok(result.kind === "outcome"); assert.deepEqual(result.outcome, f.outcome);
});

test("an outcome published during initial actor reconciliation uses startup delivery", async (t) => {
  const f = fixture(t); f.journal();
  publishProcessClaim(f.record, { kind: "claimed", id: f.record.id, executor: f.actor, supervisor: f.actor });
  mockPs(t, () => { publishOutcome(f.record, f.outcome); return `${f.actor.started} S\n`; });
  const observer = f.observer(); t.after(() => observer.detach("quit"));
  await observer.start(f.ctx, "startup");
  await new Promise<void>((resolve) => setImmediate(resolve));
  if (f.messages.length === 0) await new Promise<void>((resolve) => setTimeout(resolve, 1100));
  assert.equal(f.messages.length, 1); assert.deepEqual(f.messages[0].options, { triggerTurn: false });
});

test("startup reports unavailable evidence and still monitors its owned execution", async (t) => {
  const f = fixture(t); f.journal();
  publishProcessClaim(f.record, { kind: "claimed", id: f.record.id, executor: f.actor, supervisor: f.actor });
  const logs: string[] = []; t.mock.method(console, "info", (message: string) => logs.push(message));
  mockPs(t, () => { throw new Error("Fixture unavailable query"); });
  const observer = f.observer(); t.after(() => observer.detach("quit"));
  await observer.start(f.ctx, "startup");
  assert.ok(logs.some((line) => line.includes('"event":"initialized"') && line.includes('"unavailable":1')));
  assert.throws(() => observer.resolveResumeAvailability(f.record.launch.kind === "claude" ? "" : f.record.launch.sessionFile), /query unavailable/);
  publishOutcome(f.record, f.outcome);
  await new Promise<void>((resolve) => setTimeout(resolve, 1100));
  assert.equal(f.messages.length, 1);
});

for (const failure of ["invalid-claim", "cancellation-publication"] as const) {
  test(`startup ${failure} preserves healthy sibling delivery and later recovery`, async (t) => {
    const f = fixture(t); const peer = fixture(t); f.journal();
    const sibling = decodeRun({ ...peer.record, id: "sibling", owner: f.record.owner });
    appendFileSync(f.parent, JSON.stringify({ type: "custom", id: "sibling-launch", customType: "subagent-run", data: sibling }) + "\n");
    publishProcessClaim(sibling, { kind: "claimed", id: sibling.id, executor: peer.actor, supervisor: peer.actor });
    publishOutcome(sibling, { ...peer.outcome, id: sibling.id });
    if (failure === "invalid-claim") writeFileSync(join(f.dir, "process.json"), "invalid JSON");
    else chmodSync(f.dir, 0o500);
    const observer = f.observer();
    try {
      await observer.start(f.ctx, "startup");
      assert.equal(f.state.records.size, 2);
      assert.equal(f.messages.length, 1, "unavailable execution must not strand a healthy sibling");
      assert.match(JSON.stringify(f.messages[0]), /sibling/);
      assert.deepEqual(f.messages[0].options, { triggerTurn: false });
      assert.equal(f.state.agents.has(f.record.id), true);
      assert.ok(f.record.launch.kind !== "claude");
      const sessionFile = f.record.launch.sessionFile;
      if (failure === "invalid-claim") {
        assert.throws(() => observer.resolveResumeAvailability(sessionFile), /Invalid subagent JSON/);
        writeFileSync(join(f.dir, "process.json"), JSON.stringify({ kind: "claimed", id: f.record.id, executor: f.actor, supervisor: f.actor }));
        publishOutcome(f.record, f.outcome);
      } else {
        assert.match(observer.resolveResumeAvailability(sessionFile) ?? "", /awaiting.*claim/);
        chmodSync(f.dir, 0o700);
      }
      await new Promise<void>((resolve) => setTimeout(resolve, 1100));
      assert.equal(f.messages.length, 2, "the same observer must recover without reopening the parent");
      assert.equal(readOutcome(f.record)?.reason, failure === "invalid-claim" ? "done" : "interrupted");
      assert.equal(f.state.agents.has(f.record.id), false);
    } finally {
      chmodSync(f.dir, 0o700);
      await observer.detach("quit");
    }
  });
}

test("actor identity rejects reuse and zombies but keeps stopped actors live and query failures unavailable", (t) => {
  const f = fixture(t); let response = `${f.actor.started} T\n`;
  mockPs(t, () => response);
  assert.equal(observeActor(f.actor), "live");
  response = `${f.actor.started} Z\n`; assert.equal(observeActor(f.actor), "gone");
  response = `${f.actor.started} S\n`; assert.equal(observeActor({ ...f.actor, started: "different-start" }), "gone");
  response = "bad identity"; assert.throws(() => observeActor(f.actor), /Unparseable/);
});

test("either surviving actor prevents interruption and foreign supervisor receipts are rejected", (t) => {
  for (const survivor of ["executor", "supervisor"] as const) {
    const f = fixture(t);
    publishProcessClaim(f.record, { kind: "claimed", id: f.record.id,
      executor: survivor === "executor" ? f.actor : f.gone, supervisor: survivor === "supervisor" ? f.actor : f.gone });
    assert.deepEqual(observeRun(f.record), { kind: "pending" });
    writeFileSync(join(f.dir, "shell-exit.json"), JSON.stringify({ id: f.record.id, exitCode: 7, exitedAt: Date.now(), supervisor: { ...f.actor, started: "foreign" } }));
    assert.throws(() => observeRun(f.record), /Wrong supervisor/);
  }
});

test("immutable publication validates collisions, keeps its winner and private permissions", (t) => {
  const f = fixture(t);
  publishOutcome(f.record, f.outcome);
  assert.deepEqual(publishOutcome(f.record, { ...f.outcome, reason: "quit" }), f.outcome);
  assert.equal(statSync(join(f.dir, "completion.json")).mode & 0o777, 0o600);
  const other = fixture(t);
  writeFileSync(join(other.dir, "completion.json"), JSON.stringify({ ...other.outcome, id: "wrong" }));
  assert.throws(() => publishOutcome(other.record, other.outcome), /Wrong subagent/);
  writeFileSync(join(other.dir, "completion.json"), JSON.stringify({ id: other.record.id }));
  assert.throws(() => publishOutcome(other.record, other.outcome), /Invalid subagent/);
});

test("claimed-first cancellation loses and a not-started winner ignores every shell receipt", (t) => {
  const f = fixture(t);
  publishProcessClaim(f.record, { kind: "claimed", id: f.record.id, executor: f.actor, supervisor: f.actor });
  assert.equal(cancelUnstarted(f.record, "reopened").kind, "claimed");
  assert.deepEqual(observeRun(f.record), { kind: "pending" });
  const other = fixture(t); cancelUnstarted(other.record, "reopened");
  writeFileSync(join(other.dir, "shell-exit.json"), "corrupt losing receipt");
  const result = observeRun(other.record); assert.ok(result.kind === "outcome"); assert.equal(result.outcome.reason, "interrupted");
});

test("shell-only resumed output freezes before history changes and classifies selected errors", (t) => {
  for (const failure of [false, true]) {
    const f = fixture(t); assert.ok(f.record.launch.kind !== "claude");
    const child = f.record.launch.sessionFile;
    const header = { type: "session", version: 3, id: "child", cwd: f.dir };
    const answer = (id: string, parentId: string | null, text: string, stopReason: string) => ({ type: "message", id, parentId,
      message: { role: "assistant", content: [{ type: "text", text }], stopReason, timestamp: Date.now(), errorMessage: "Fixture error" } });
    writeFileSync(child, [header, answer("anchor", null, "Earlier answer", "stop"), answer("new", "anchor", "New selected answer", failure ? "length" : "stop")].map((entry) => JSON.stringify(entry)).join("\n") + "\n");
    publishProcessClaim(f.record, { kind: "claimed", id: f.record.id, executor: f.gone, supervisor: f.gone });
    const exitedAt = f.record.startTime;
    writeFileSync(join(f.dir, "shell-exit.json"), JSON.stringify({ id: f.record.id, exitCode: 7, exitedAt, supervisor: f.gone }));
    const outcome = captureShellOutcome(f.record); assert.ok(outcome);
    assert.equal(outcome.recordedAt, exitedAt, "known shell duration must not include recovery downtime");
    assert.equal(outcome.reason, failure ? "error" : "sentinel");
    assert.doesNotMatch(JSON.stringify(outcome), /Earlier answer/);
    if (!failure) assert.match(JSON.stringify(outcome), /New selected answer/);
    appendFileSync(child, JSON.stringify(answer("later", "new", "Later mutation", "stop")) + "\n");
    assert.deepEqual(readOutcome(f.record), outcome);
  }
});

test("bootstrap query and partial-write failures never claim or execute a CLI", (t) => {
  for (const fault of ["query", "write"]) {
    const f = fixture(t);
    const injection = join(f.dir, "shell-environment");
    writeFileSync(injection, fault === "query" ? "" : `printf() {
case "$1" in
  *kind*claimed*) builtin printf '{'; return 1;;
  *) builtin printf "$@";;
esac
}\n`);
    const failedQuery = join(f.dir, "failed-query");
    writeFileSync(failedQuery, "#!/bin/bash\nexit 2\n", { mode: 0o700 });
    const script = buildRunCommand({ id: f.record.id, runDir: f.dir, cwd: f.dir, execCommand: "exec /usr/bin/touch executed" });
    const result = spawnSync("/bin/bash", ["-c", fault === "query" ? script.replaceAll("/bin/ps", failedQuery) : script],
      { encoding: "utf8", env: { ...process.env, BASH_ENV: injection } });
    assert.equal(existsSync(join(f.dir, "executed")), false);
    assert.equal(existsSync(join(f.dir, "shell-exit.json")), false);
    const claim = JSON.parse(readFileSync(join(f.dir, "process.json"), "utf8"));
    assert.equal(claim.kind, "not_started"); assert.equal(claim.cause, "bootstrap_failed");
    assert.match(result.stderr, /bootstrap_failed/);
    assert.equal(statSync(f.dir).mode & 0o777, 0o700);
    assert.equal(statSync(join(f.dir, "process.json")).mode & 0o777, 0o600);
  }
});

test("the real Claude publisher rejects corrupt same-id collisions and preserves a valid winner", (t) => {
  for (const corrupt of [true, false]) {
    const f = fixture(t); const transcript = join(f.dir, "claude.jsonl");
    writeFileSync(transcript, JSON.stringify({ type: "user", message: { content: "Fixture" } }) + "\n");
    const original = corrupt ? { id: f.record.id } : { ...f.outcome, output: { cli: "claude", text: "Earlier captured answer", transcriptPath: transcript } };
    writeFileSync(join(f.dir, "completion.json"), JSON.stringify(original));
    const result = spawnSync("/bin/bash", [join(import.meta.dirname, "../pi-extension/subagents/plugin/hooks/on-stop.sh")], {
      encoding: "utf8", env: { ...process.env, PI_SUBAGENT_ID: f.record.id, PI_SUBAGENT_RUN: JSON.stringify({ cli: "claude", runDir: f.dir }) },
      input: JSON.stringify({ stop_hook_active: false, transcript_path: transcript, last_assistant_message: "Later answer" }),
    });
    assert.equal(result.status, corrupt ? 1 : 0);
    if (corrupt) assert.match(result.stderr, /claude_publication_failed/);
    assert.deepEqual(JSON.parse(readFileSync(join(f.dir, "completion.json"), "utf8")), original);
  }
});

test("child-created files inherit the operator umask while PIS facts remain private", (t) => {
  for (const mask of ["022", "002"]) {
    const f = fixture(t);
    const command = buildRunCommand({ id: f.record.id, runDir: f.dir, cwd: f.dir,
      execCommand: "exec /bin/sh -c 'umask > child-mask; : > child-file; mkdir child-dir'" });
    execFileSync("/bin/bash", ["-c", `umask ${mask}\n${command}`], { env: { ...process.env, BASH_ENV: "" } });
    const requestedMask = Number.parseInt(mask, 8);
    assert.equal(Number.parseInt(readFileSync(join(f.dir, "child-mask"), "utf8"), 8), requestedMask);
    assert.equal(statSync(join(f.dir, "child-file")).mode & 0o777, 0o666 & ~requestedMask);
    assert.equal(statSync(join(f.dir, "child-dir")).mode & 0o777, 0o777 & ~requestedMask);
    for (const file of ["process.json", "shell-exit.json"]) assert.equal(statSync(join(f.dir, file)).mode & 0o777, 0o600);
  }
});
