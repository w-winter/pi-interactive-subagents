import { execFileSync } from "node:child_process";
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { decodeRun, publishProcessClaim, publishOutcome, readOutcome, type RunRecord } from "../pi-extension/subagents/run-records.ts";
import { pollForExit } from "../pi-extension/subagents/completion.ts";
import subagentDoneExtension from "../pi-extension/subagents/subagent-done.ts";

import { __test__ } from "../pi-extension/subagents/index.ts";

type CompletionMessage = { role: "assistant" } & (
  | { stopReason: "stop" | "aborted" }
  | { stopReason: "error"; errorMessage: string }
  | { stopReason: "length"; content: { type: "text"; text: string }[] }
);
type CompletionEvent =
  | { type: "agent_end"; messages: CompletionMessage[] }
  | { type: "agent_settled" };
type CompletionHandler = (event: CompletionEvent, ctx: { shutdown(): void }) => void;

function withChild(run: (emit: (event: CompletionEvent) => void, exit: string, shutdowns: () => number) => void) {
  const directory = mkdtempSync(join(tmpdir(), "pis-completion-"));
  const session = join(directory, "session.jsonl");
  const previousEnv = { ...process.env };
  process.env.PI_SUBAGENT_ID = "settlement-fixture";
  process.env.PI_SUBAGENT_RUN = JSON.stringify({ cli: "pi", runDir: directory, outputAfter: 0 });
  const previousSession = process.env.PI_SUBAGENT_SESSION;
  const previousAutoExit = process.env.PI_SUBAGENT_AUTO_EXIT;
  process.env.PI_SUBAGENT_SESSION = session;
  process.env.PI_SUBAGENT_AUTO_EXIT = "1";
  const handlers = new Map<string, CompletionHandler>();
  let shutdowns = 0;
  const api = {
    on(event: string, handler: CompletionHandler) { handlers.set(event, handler); },
    registerTool() {},
    registerShortcut() {},
    getAllTools() { return []; },
  };
  try {
    // SAFETY: This runtime double dispatches only completion events; their handlers use messages and shutdown.
    subagentDoneExtension(api as Parameters<typeof subagentDoneExtension>[0]);
    run((event) => {
      const handler = handlers.get(event.type);
      assert.ok(handler, `Missing ${event.type} handler`);
      handler(event, { shutdown() { shutdowns++; } });
    }, join(directory, "completion.json"), () => shutdowns);
  } finally {
    if (previousSession === undefined) delete process.env.PI_SUBAGENT_SESSION;
    else process.env.PI_SUBAGENT_SESSION = previousSession;
    if (previousAutoExit === undefined) delete process.env.PI_SUBAGENT_AUTO_EXIT;
    else process.env.PI_SUBAGENT_AUTO_EXIT = previousAutoExit;
    process.env = previousEnv;
    rmSync(directory, { recursive: true, force: true });
  }
}

describe("settled child completion", () => {
  it("waits through a retryable error and a recovered response before reporting success", () => withChild((emit, exit, shutdowns) => {
    emit({ type: "agent_end", messages: [{ role: "assistant", stopReason: "error", errorMessage: "529 overloaded" }] });
    assert.equal(existsSync(exit), false);
    assert.equal(shutdowns(), 0);
    emit({ type: "agent_end", messages: [{ role: "assistant", stopReason: "stop" }] });
    assert.equal(existsSync(exit), false);
    emit({ type: "agent_settled" });
    assert.equal(JSON.parse(readFileSync(exit, "utf8")).reason, "done");
    assert.equal(shutdowns(), 1);
  }));

  it("reports truncated output as a failure to the parent", () => withChild((emit, exit, shutdowns) => {
    emit({ type: "agent_end", messages: [{ role: "assistant", stopReason: "length", content: [{ type: "text", text: "Partial review" }] }] });
    emit({ type: "agent_settled" });
    const payload = JSON.parse(readFileSync(exit, "utf8"));
    assert.equal(payload.reason, "error");
    assert.equal(payload.stopReason, "length");
    assert.match(payload.errorMessage, /token limit.*incomplete/i);
    const notification = __test__.resolveResultPresentation({
      elapsed: 1, summary: "Partial review", exitReason: "error", exitCode: 1, errorMessage: payload.errorMessage,
    }, "Reviewer");
    assert.match(notification, /failed/);
    assert.match(notification, /token limit.*incomplete/i);
    assert.doesNotMatch(notification, /auto-retry exhausted/);
    assert.equal(shutdowns(), 1);
  }));

  it("leaves an interrupted session open and completes a later resumed turn", () => withChild((emit, exit, shutdowns) => {
    emit({ type: "agent_end", messages: [{ role: "assistant", stopReason: "aborted" }] });
    emit({ type: "agent_settled" });
    assert.equal(existsSync(exit), false);
    assert.equal(shutdowns(), 0);
    emit({ type: "agent_end", messages: [{ role: "assistant", stopReason: "stop" }] });
    emit({ type: "agent_settled" });
    assert.equal(JSON.parse(readFileSync(exit, "utf8")).reason, "done");
    assert.equal(shutdowns(), 1);
  }));
});

async function withObservedRun(run: (record: RunRecord) => Promise<void>) {
  const dir = mkdtempSync(join(tmpdir(), "pis-observation-"));
  const record = decodeRun({
    id: "observation-proof", name: "Child", task: "", agent: null, startTime: Date.now(), interactive: true,
    owner: { sessionId: "parent", sessionFile: join(dir, "parent.jsonl") }, runDir: dir,
    launch: { kind: "pi-fresh", sessionFile: join(dir, "child.jsonl"), activityFile: null, stderrFile: null, autoExit: false },
  });
  try { await run(record); } finally { execFileSync("trash", [dir]); }
}
function liveClaim(record: RunRecord) {
  const actor = { pid: process.pid, started: execFileSync("/bin/ps", ["-p", String(process.pid), "-o", "lstart="],
    { encoding: "utf8", env: { ...process.env, LC_ALL: "C", TZ: "UTC" } }).trim() };
  publishProcessClaim(record, { kind: "claimed", id: record.id, executor: actor, supervisor: actor });
}

it("keeps observing after a failed closure probe and settles only after closure is confirmed", async () => withObservedRun(async (record) => {
  let probes = 0;
  const result = await pollForExit(record, new AbortController().signal, {
    interval: 1, onTick() {}, onUnavailable() {}, claimMissing: null, operatorClosed: async () => {
      if (++probes === 1) throw new Error("Fixture probe unavailable");
      return true;
    },
  });
  assert.equal(probes, 2);
  assert.ok(result.kind === "outcome"); assert.equal(result.outcome.reason, "quit");
}));
it("a semantic outcome published during the closure probe wins over operator closure", async () => withObservedRun(async (record) => {
  liveClaim(record);
  const result = await pollForExit(record, new AbortController().signal, {
    interval: 1, onTick() {}, onUnavailable() {}, claimMissing: null, operatorClosed: async () => {
      publishOutcome(record, { id: record.id, recordedAt: Date.now(), reason: "done", output: { cli: "pi", text: "Captured result" } });
      return true;
    },
  });
  assert.ok(result.kind === "outcome"); assert.equal(result.outcome.reason, "done");
}));
it("confirmed closure does not finish a live claimed writer and polling remains cancellable", async () => withObservedRun(async (record) => {
  liveClaim(record);
  const abort = new AbortController();
  await assert.rejects(pollForExit(record, abort.signal, {
    interval: 1, operatorClosed: async () => true, onUnavailable() {}, claimMissing: null, onTick: () => abort.abort(),
  }), { name: "AbortError" });
  assert.equal(readOutcome(record), null);
}));
