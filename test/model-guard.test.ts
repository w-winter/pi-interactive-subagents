import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, mkdirSync, readFileSync, realpathSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { RpcClient, SessionManager } from "/opt/homebrew/lib/node_modules/@earendil-works/pi-coding-agent/dist/index.js";
import { seedSubagentSessionFile } from "../pi-extension/subagents/session.ts";
import { buildResumeArgs, type ConversationProfile } from "../pi-extension/subagents/conversation-profile.ts";

const root = fileURLToPath(new URL("../", import.meta.url));
const cliPath = "/opt/homebrew/lib/node_modules/@earendil-works/pi-coding-agent/dist/bundle/cli.js";
const childExtension = join(root, "pi-extension/subagents/subagent-done.ts");
const provider = join(root, "test/fixtures/model-guard-provider.ts");
const meddler = join(root, "test/fixtures/model-guard-meddler.ts");

test("subagent selection survives extension setters; manual changes survive turns, reload, and resume", async (t) => {
  const dir = realpathSync(mkdtempSync(join(tmpdir(), "pi-model-guard-")));
  const sessionDir = join(dir, "sessions");
  const sessionPath = join(sessionDir, "child.jsonl");
  const profile: ConversationProfile = {
    systemPromptPath: join(dir, "role.md"), cwd: dir, agentDir: dir,
    model: "guard-test/astra", thinking: "xhigh",
  };
  writeFileSync(profile.systemPromptPath, "Return the fixture provider's output.\n");
  seedSubagentSessionFile({
    mode: "lineage-only", parentSessionFile: join(dir, "parent.jsonl"), childSessionFile: sessionPath, childCwd: dir,
  });
  const receipt: Record<string, { model: string; thinking: string }> = {};
  const args = [
    "--offline", "--no-extensions", "--no-skills", "--no-prompt-templates", "--no-context-files", "--no-tools",
    "--session-dir", sessionDir, "--session", sessionPath, "-e", meddler, "-e", childExtension, "-e", provider,
  ];
  function client(selectionArgs: string[]) {
    return new RpcClient({
      cliPath, cwd: dir, args: [...args, ...selectionArgs],
      env: {
        PI_CODING_AGENT_DIR: dir,
        PI_SUBAGENT_RUN: JSON.stringify({ cli: "pi", runDir: dir, outputAfter: 0 }), PI_SUBAGENT_SESSION: sessionPath,
        PI_SUBAGENT_AUTO_EXIT: "0",
        PI_SUBAGENT_ID: "model-guard-test",
        PI_SUBAGENT_ACTIVITY_FILE: "",
        PI_SUBAGENT_CONVERSATION_PROFILE: JSON.stringify(profile),
      },
    });
  }
  async function checkState(rpc: RpcClient, phase: string, model: string, thinking: string) {
    const state = await rpc.getState();
    const selection = { model: state.model?.id ?? "none", thinking: state.thinkingLevel };
    receipt[phase] = selection;
    assert.deepEqual(selection, { model, thinking });
  }
  async function checkRequest(rpc: RpcClient, phase: string, model: string, thinking: string) {
    await rpc.promptAndWait(phase);
    const text = await rpc.getLastAssistantText();
    assert.ok(text);
    const output: unknown = JSON.parse(text);
    assert.deepEqual(output, { model, thinking });
    await checkState(rpc, phase, model, thinking);
  }

  const rpc = client(["--model", "guard-test/astra", "--thinking", "xhigh"]);
  try {
    await rpc.start();
    await checkState(rpc, "startup", "astra", "xhigh");
    await checkRequest(rpc, "first-request", "astra", "xhigh");

    await rpc.setModel("guard-test", "sol");
    await rpc.setThinkingLevel("low");
    await checkRequest(rpc, "manual-selection", "sol", "low");
    assert.equal(await rpc.prompt("/guard-reselect"), "handled");
    await checkState(rpc, "same-model-reselection", "sol", "low");

    assert.equal(await rpc.prompt("/guard-reload"), "handled");
    await checkRequest(rpc, "reload", "sol", "low");

    await rpc.setThinkingLevel("off");
    await checkRequest(rpc, "manual-thinking-off", "sol", "off");
    await rpc.stop();

    const resumed = client(buildResumeArgs(sessionPath, profile));
    try {
      await resumed.start();
      await checkState(resumed, "resume-startup", "sol", "off");
      await checkRequest(resumed, "resume-request", "sol", "off");
      const { entries } = await resumed.getEntries();
      const rejections = entries.filter((e) => e.type === "custom" && e.customType === "subagent-selection-rejected");
      assert.ok(rejections.length > 0, "blocked overrides must be recorded");
      const artifacts = join(root, "test/artifacts/model-guard");
      mkdirSync(artifacts, { recursive: true });
      writeFileSync(join(artifacts, "receipt.json"), JSON.stringify({ selection: receipt, rejections, paidRequests: 0 }, null, 2) + "\n");
      writeFileSync(join(artifacts, "session.jsonl"), readFileSync(sessionPath));
      t.diagnostic(`Verification artifacts: ${artifacts}`);
    } finally {
      await resumed.stop();
    }
  } finally {
    await rpc.stop();
    execFileSync("trash", [dir]);
  }
});

test("loading the child extension in an ordinary session does not restrict extension selection", async () => {
  const dir = mkdtempSync(join(tmpdir(), "pi-model-guard-main-"));
  const rpc = new RpcClient({
    cliPath, cwd: dir,
    args: [
      "--offline", "--no-session", "--no-extensions", "--no-skills", "--no-context-files", "--no-tools",
      "-e", childExtension, "-e", provider, "-e", meddler,
      "--model", "guard-test/astra", "--thinking", "xhigh",
    ],
    env: { PI_CODING_AGENT_DIR: dir, PI_SUBAGENT_SESSION: "", PI_SUBAGENT_AUTO_EXIT: "0" },
  });
  try {
    await rpc.start();
    const state = await rpc.getState();
    assert.equal(state.model?.id, "sol");
    assert.equal(state.thinkingLevel, "medium");
  } finally {
    await rpc.stop();
    assert.doesNotMatch(rpc.getStderr(), /quit_publication_failed/);
    execFileSync("trash", [dir]);
  }
});

test("fork launch overrides remain authoritative when resumed before the first child request", async (t) => {
  const dir = realpathSync(mkdtempSync(join(tmpdir(), "pi-model-guard-fork-")));
  const sessionDir = join(dir, "sessions");
  const parent = SessionManager.create(dir, sessionDir);
  parent.appendModelChange("guard-test", "sol");
  parent.appendThinkingLevelChange("low");
  parent.appendMessage({ role: "user", content: "Parent history", timestamp: Date.now() });
  parent.appendMessage({
    role: "assistant", content: [{ type: "text", text: "Parent response" }],
    api: "openai-responses", provider: "guard-test", model: "sol",
    usage: {
      input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0,
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
    },
    stopReason: "stop", timestamp: Date.now(),
  });
  parent.appendMessage({ role: "user", content: "Fork trigger", timestamp: Date.now() });
  const parentFile = parent.getSessionFile();
  assert.ok(parentFile);
  const sessionPath = join(sessionDir, "fork.jsonl");
  seedSubagentSessionFile({ mode: "fork", parentSessionFile: parentFile, childSessionFile: sessionPath, childCwd: dir });
  function client(selectionArgs: string[]) {
    return new RpcClient({
      cliPath, cwd: dir,
      args: [
        "--offline", "--no-extensions", "--no-skills", "--no-context-files", "--no-tools",
        "--session-dir", sessionDir, "--session", sessionPath,
        "-e", meddler, "-e", childExtension, "-e", provider, ...selectionArgs,
      ],
      env: { PI_CODING_AGENT_DIR: dir, PI_SUBAGENT_RUN: JSON.stringify({ cli: "pi", runDir: dir, outputAfter: 0 }), PI_SUBAGENT_ID: "model-guard-fork", PI_SUBAGENT_SESSION: sessionPath, PI_SUBAGENT_AUTO_EXIT: "0" },
    });
  }
  const initial = client(["--model", "guard-test/astra", "--thinking", "xhigh"]);
  try {
    await initial.start();
    const first = await initial.getState();
    assert.equal(first.model?.id, "astra");
    assert.equal(first.thinkingLevel, "xhigh");
    await initial.stop();
    const resumed = client(buildResumeArgs(sessionPath, null));
    try {
      await resumed.start();
      const state = await resumed.getState();
      assert.equal(state.model?.id, "astra");
      assert.equal(state.thinkingLevel, "xhigh");
      await resumed.promptAndWait("First child request after resume");
      const text = await resumed.getLastAssistantText();
      assert.ok(text);
      const request: unknown = JSON.parse(text);
      assert.deepEqual(request, { model: "astra", thinking: "xhigh" });
      const artifacts = join(root, "test/artifacts/model-guard");
      mkdirSync(artifacts, { recursive: true });
      writeFileSync(join(artifacts, "fork-receipt.json"), JSON.stringify({
        initial: { model: first.model.id, thinking: first.thinkingLevel },
        resumed: { model: state.model.id, thinking: state.thinkingLevel },
        request, paidRequests: 0,
      }, null, 2) + "\n");
      writeFileSync(join(artifacts, "fork-session.jsonl"), readFileSync(sessionPath));
      t.diagnostic(`Fork verification artifacts: ${artifacts}`);
    } finally {
      await resumed.stop();
    }
  } finally {
    await initial.stop();
    execFileSync("trash", [dir]);
  }
});
