import { it } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, realpathSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { setTimeout } from "node:timers/promises";
import { Type } from "@sinclair/typebox";
import { Value } from "@sinclair/typebox/value";
import { cliCommand } from "../../pi-extension/subagents/orca.ts";
import { pollForExit } from "../../pi-extension/subagents/completion.ts";
import { buildRunCommand } from "../../pi-extension/subagents/launch-command.ts";
import { decodeRun } from "../../pi-extension/subagents/run-records.ts";
import {
  createSurface, sendCommand, sendEscape, readScreenAsync,
  closeSurface, shellEscape, sendLongCommand,
} from "../../pi-extension/subagents/mux.ts";

function activeTabs(): string[] {
  const schema = Type.Object({
    ok: Type.Literal(true),
    result: Type.Object({
      visualLayouts: Type.Array(Type.Object({
        root: Type.Object({ activeTabId: Type.String() }),
      })),
    }),
  });
  const value: unknown = JSON.parse(execFileSync(cliCommand(), [
    "terminal", "list", "--include-visual-layouts", "--json",
  ], { encoding: "utf8" }));
  assert.ok(Value.Check(schema, value), "Expected Orca visual tab layout");
  return value.result.visualLayouts.map((layout) => layout.root.activeTabId);
}

it("Orca tabs preserve focus, target input, deliver Escape, and report completion", {
  skip: !process.env.ORCA_TERMINAL_HANDLE,
  timeout: 30_000,
}, async () => {
  const previous = process.env.PI_SUBAGENT_MUX;
  process.env.PI_SUBAGENT_MUX = "orca";
  const children: string[] = [];
  const runDir = realpathSync(mkdtempSync(join(tmpdir(), "pis-orca-shell-")));
  const signal = AbortSignal.timeout(25_000);
  async function waitForOutput(handle: string, marker: string): Promise<string> {
    for (;;) {
      signal.throwIfAborted();
      const screen = await readScreenAsync(handle, 50);
      if (screen.includes(marker)) return screen;
      await setTimeout(100, undefined, { signal });
    }
  }
  try {
    const focused = activeTabs();
    const first = createSurface("pi-orca-test-a");
    children.push(first);
    const second = createSurface("pi-orca-test-b");
    children.push(second);
    assert.notEqual(first, second);
    assert.deepEqual(activeTabs(), focused);
    // Match the production shell-startup allowance before sending a command.
    await setTimeout(Number(process.env.PI_SUBAGENT_SHELL_READY_DELAY_MS ?? "500"));
    const rawInput = [
      'process.stdin.setRawMode(true);',
      'console.log("RAW_" + "READY");',
      'process.stdin.once("data", b => { console.log("BYTE_" + b[0]); process.exit(0); });',
    ].join(" ");
    sendCommand(first, "node -e " + shellEscape(rawInput));
    await waitForOutput(first, "RAW_READY");
    sendEscape(first);
    await waitForOutput(first, "BYTE_27");
    const run = decodeRun({ id: "orca-shell", name: "Orca shell", task: "", agent: null,
      startTime: Date.now(), interactive: true, runDir, owner: { sessionId: "integration", sessionFile: join(runDir, "parent.jsonl") },
      launch: { kind: "pi-fresh", sessionFile: join(runDir, "child.jsonl"), activityFile: null, stderrFile: null, autoExit: false } });
    sendLongCommand(second, buildRunCommand({ id: run.id, runDir, cwd: runDir, execCommand: "exec /usr/bin/true" }), { scriptPath: join(runDir, "launch.sh") });
    const result = await pollForExit(run, signal, { interval: 100, onTick() {}, onUnavailable() {}, operatorClosed: null, claimMissing: null });
    assert.ok(result.kind === "outcome" && result.outcome.reason === "sentinel");
    assert.equal(result.outcome.exitCode, 0);
    assert.ok(!(await readScreenAsync(first, 50)).includes("__SUBAGENT_DONE_0__"));
  } finally {
    try {
      for (const child of children) closeSurface(child);
    } finally {
      if (previous === undefined) delete process.env.PI_SUBAGENT_MUX;
      else process.env.PI_SUBAGENT_MUX = previous;
      execFileSync("trash", [runDir]);
    }
  }
});
