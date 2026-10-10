import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, realpathSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { RpcClient } from "/opt/homebrew/lib/node_modules/@earendil-works/pi-coding-agent/dist/index.js";
import { Type } from "@sinclair/typebox";
import { Value } from "@sinclair/typebox/value";

const root = fileURLToPath(new URL("../", import.meta.url));
const Snapshot = Type.Object({
  declaredTools: Type.Array(Type.String()), registeredTools: Type.Array(Type.String()),
  systemPrompt: Type.String(), agentDir: Type.String(), cwd: Type.String(), pid: Type.Number(),
});

for (const abrupt of [false, true]) {
  test(`operator tool broadening survives ${abrupt ? "abrupt termination" : "reload and quit"}`, async (t) => {
    const dir = realpathSync(mkdtempSync(join(tmpdir(), "pis-resume-tools-")));
    const sessions = join(dir, "sessions");
    mkdirSync(sessions);
    const session = join(sessions, "child.jsonl");
    const promptPath = join(dir, "role.md");
    writeFileSync(promptPath, "ORIGINAL_ROLE_INSTRUCTIONS");
    const launch = {
      cwd: dir, agentDir: dir, agent: "restricted",
      tools: ["read", "caller_ping", "subagent_done"],
      deniedTools: ["subagent", "subagent_resume", "subagent_interrupt", "subagents_list"],
      systemPrompt: { mode: "append", path: promptPath },
    };
    const options = {
      cliPath: "/opt/homebrew/lib/node_modules/@earendil-works/pi-coding-agent/dist/bundle/cli.js",
      cwd: dir,
      args: [
        "--offline", "--no-extensions", "--no-skills", "--no-context-files", "--no-prompt-templates",
        "--session-dir", sessions, "--session", session, "--model", "launch-audit/snapshot", "--thinking", "off",
        "--append-system-prompt", promptPath,
        "-e", join(root, "test/fixtures/launch-audit-provider.ts"),
        "-e", join(root, "pi-extension/subagents/index.ts"),
        "-e", "/Users/ww/dot314/agent/extensions/tools/index.ts",
        "-e", join(root, "pi-extension/subagents/subagent-done.ts"),
        "-e", join(root, "test/fixtures/operator-tools.ts"),
      ],
      env: {
        PI_CODING_AGENT_DIR: dir, PI_SUBAGENT_RUN: JSON.stringify({ cli: "pi", runDir: dir, outputAfter: 0 }), PI_SUBAGENT_SESSION: session, PI_SUBAGENT_AUTO_EXIT: "0",
        PI_SUBAGENT_ID: "operator-tools-test", PI_SUBAGENT_ACTIVITY_FILE: "",
        PI_SUBAGENT_CONVERSATION_PROFILE: "", PI_SUBAGENT_LAUNCH_SETTINGS: JSON.stringify(launch),
      },
    };
    const first = new RpcClient(options);
    const resumed = new RpcClient(options);
    try {
      await first.start();
      await first.promptAndWait("Report initial tools");
      const initialText = await first.getLastAssistantText();
      assert.ok(initialText);
      const initial = Value.Decode(Snapshot, JSON.parse(initialText));
      assert.deepEqual(initial.declaredTools, launch.tools.toSorted());
      assert.ok(initial.registeredTools.includes("write"));
      assert.ok(initial.registeredTools.includes("subagent"));
      assert.equal(await first.prompt("/audit-enable write,subagent"), "handled");
      if (abrupt) {
        process.kill(initial.pid, "SIGKILL");
      } else {
        assert.equal(await first.prompt("/audit-reload"), "handled");
        await first.promptAndWait("Report tools after reload");
        const reloadedText = await first.getLastAssistantText();
        assert.ok(reloadedText);
        const reloaded = Value.Decode(Snapshot, JSON.parse(reloadedText));
        assert.deepEqual(reloaded.declaredTools, [...launch.tools, "write", "subagent"].toSorted());
        assert.equal(await first.prompt("/audit-quit"), "handled");
      }
      await first.stop();
      await resumed.start();
      await resumed.promptAndWait("Report resumed tools");
      const restoredText = await resumed.getLastAssistantText();
      assert.ok(restoredText);
      const restored = Value.Decode(Snapshot, JSON.parse(restoredText));
      const artifacts = join(root, "test/artifacts/resume-restrictions");
      mkdirSync(artifacts, { recursive: true });
      writeFileSync(join(artifacts, `operator-${abrupt ? "abrupt" : "orderly"}-receipt.json`), JSON.stringify({ initial, restored, paidRequests: 0 }, null, 2));
      writeFileSync(join(artifacts, `operator-${abrupt ? "abrupt" : "orderly"}-session.jsonl`), readFileSync(session));
      assert.deepEqual(restored.declaredTools, [...launch.tools, "write", "subagent"].toSorted());
      assert.match(restored.systemPrompt, /ORIGINAL_ROLE_INSTRUCTIONS/);
      t.diagnostic(`Verification artifacts: ${artifacts}`);
    } finally {
      await first.stop();
      await resumed.stop();
      execFileSync("trash", [dir]);
    }
  });
}
