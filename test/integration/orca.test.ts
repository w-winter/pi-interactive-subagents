import { it } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { setTimeout } from "node:timers/promises";
import { Type } from "@sinclair/typebox";
import { Value } from "@sinclair/typebox/value";
import { cliCommand } from "../../pi-extension/subagents/orca.ts";
import {
  createSurface, sendCommand, sendEscape, readScreenAsync,
  closeSurface, pollForExit, shellEscape,
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
    sendCommand(second, "printf '__SUBAGENT_%s_0__\\n' DONE");
    const result = await pollForExit(second, signal, { interval: 100 });
    assert.deepEqual(result, { reason: "sentinel", exitCode: 0 });
    assert.ok(!(await readScreenAsync(first, 50)).includes("__SUBAGENT_DONE_0__"));
  } finally {
    try {
      for (const child of children) closeSurface(child);
    } finally {
      if (previous === undefined) delete process.env.PI_SUBAGENT_MUX;
      else process.env.PI_SUBAGENT_MUX = previous;
    }
  }
});
