import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, realpathSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { RpcClient } from "/opt/homebrew/lib/node_modules/@earendil-works/pi-coding-agent/dist/index.js";
import { findLastAssistantMessage, getBranchEntries } from "../pi-extension/subagents/session.ts";

const root = fileURLToPath(new URL("../", import.meta.url));

test("PIS extracts the selected branch's answer after native tree navigation", async (t) => {
  const dir = realpathSync(mkdtempSync(join(tmpdir(), "pis-branch-result-")));
  const sessionDir = join(dir, "sessions");
  const sessionPath = join(sessionDir, "child.jsonl");
  mkdirSync(sessionDir);
  const options = {
    cliPath: "/opt/homebrew/lib/node_modules/@earendil-works/pi-coding-agent/dist/bundle/cli.js",
    cwd: dir,
    args: [
      "--offline", "--no-extensions", "--no-skills", "--no-prompt-templates", "--no-context-files", "--no-tools",
      "--session-dir", sessionDir, "--session", sessionPath,
      "--model", "guard-test/astra", "--thinking", "off",
      "-e", join(root, "test/fixtures/model-guard-provider.ts"),
      "-e", join(root, "test/fixtures/branch-navigation.ts"),
      "-e", join(root, "pi-extension/subagents/subagent-done.ts"),
    ],
    env: {
      PI_CODING_AGENT_DIR: dir, PI_SUBAGENT_SESSION: sessionPath, PI_SUBAGENT_AUTO_EXIT: "0",
      PI_SUBAGENT_ID: "branch-result-test", PI_SUBAGENT_ACTIVITY_FILE: "",
      PI_SUBAGENT_CONVERSATION_PROFILE: "",
    },
  };
  const rpc = new RpcClient(options);
  try {
    await rpc.start();
    await rpc.promptAndWait("First answer");
    const first = await rpc.getLastAssistantText();
    assert.ok(first);
    const { entries } = await rpc.getEntries();
    const selected = entries.findLast((entry) => entry.type === "message" && entry.message.role === "assistant");
    assert.ok(selected);

    await rpc.setModel("guard-test", "sol");
    await rpc.promptAndWait("Second answer, to be abandoned");
    const abandoned = await rpc.getLastAssistantText();
    assert.ok(abandoned);
    assert.notEqual(first, abandoned);

    assert.equal(await rpc.prompt(`/branch-result-select ${selected.id}`), "handled");
    assert.equal(await rpc.getLastAssistantText(), first);
    // /name persists a new entry on the selected branch without requesting another answer.
    await rpc.setSessionName("Selected first answer");
    await rpc.stop();

    const actual = findLastAssistantMessage(getBranchEntries(sessionPath, 0));
    const artifacts = join(root, "test/artifacts/branch-result");
    mkdirSync(artifacts, { recursive: true });
    writeFileSync(join(artifacts, "session.jsonl"), readFileSync(sessionPath));
    const resumed = new RpcClient(options);
    let restored: string | null;
    try {
      await resumed.start();
      restored = await resumed.getLastAssistantText();
    } finally {
      await resumed.stop();
    }
    writeFileSync(join(artifacts, "receipt.json"), JSON.stringify({
      sourceHead: execFileSync("git", ["rev-parse", "HEAD"], { cwd: root, encoding: "utf8" }).trim(),
      selectedEntryId: selected.id, expected: first, abandoned, restored, actual,
      matchesSelectedBranch: actual === first, paidRequests: 0,
    }, null, 2) + "\n");
    t.diagnostic(`Verification artifacts: ${artifacts}`);
    assert.equal(restored, first, "a new Pi process must agree on the persisted branch");
    assert.equal(actual, first, "PIS must not return an answer from an abandoned branch");
  } finally {
    await rpc.stop();
    execFileSync("trash", [dir]);
  }
});
