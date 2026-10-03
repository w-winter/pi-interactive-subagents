import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import subagentDoneExtension from "../pi-extension/subagents/subagent-done.ts";
import { __pollForExitTest__ } from "../pi-extension/subagents/mux.ts";
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
    }, `${session}.exit`, () => shutdowns);
  } finally {
    if (previousSession === undefined) delete process.env.PI_SUBAGENT_SESSION;
    else process.env.PI_SUBAGENT_SESSION = previousSession;
    if (previousAutoExit === undefined) delete process.env.PI_SUBAGENT_AUTO_EXIT;
    else process.env.PI_SUBAGENT_AUTO_EXIT = previousAutoExit;
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
    assert.deepEqual(JSON.parse(readFileSync(exit, "utf8")), { type: "done" });
    assert.equal(shutdowns(), 1);
  }));

  it("reports truncated output as a failure to the parent", () => withChild((emit, exit, shutdowns) => {
    emit({ type: "agent_end", messages: [{ role: "assistant", stopReason: "length", content: [{ type: "text", text: "Partial review" }] }] });
    emit({ type: "agent_settled" });
    const payload = JSON.parse(readFileSync(exit, "utf8"));
    assert.equal(payload.type, "error");
    assert.equal(payload.stopReason, "length");
    assert.match(payload.errorMessage, /token limit.*incomplete/i);
    const result = __pollForExitTest__.interpretExitSidecar(payload);
    assert.equal(result.reason, "error");
    assert.equal(result.exitCode, 1);
    assert.equal(result.errorMessage, payload.errorMessage);
    const notification = __test__.resolveResultPresentation({
      ...result, elapsed: 1, summary: "Partial review", exitReason: result.reason,
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
    assert.deepEqual(JSON.parse(readFileSync(exit, "utf8")), { type: "done" });
    assert.equal(shutdowns(), 1);
  }));
});
