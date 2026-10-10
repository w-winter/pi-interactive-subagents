import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { setTimeout } from "node:timers/promises";
import test from "node:test";
import { RpcClient } from "/opt/homebrew/lib/node_modules/@earendil-works/pi-coding-agent/dist/index.js";
import { createSubagentActivityRecorder, readSubagentActivityFile } from "../pi-extension/subagents/activity.ts";
import { advanceStatusState, classifyStatus, createStatusState, formatStatusLine, observeStatus } from "../pi-extension/subagents/status.ts";

const FIXTURE_WAIT_MS = 30_000;
const FIXTURE_POLL_MS = 20;

test("dialog status survives concurrent tool updates and returns to active or waiting", (t) => {
  const dir = mkdtempSync(join(tmpdir(), "pis-dialog-status-"));
  t.after(() => execFileSync("trash", [dir]));
  const path = join(dir, "activity.json");
  let now = 1000;
  const recorder = createSubagentActivityRecorder({ runningChildId: "dialog", activityFile: path, now: () => now });
  recorder.agentStart();
  recorder.toolExecutionStart("call", "confirm-tool");
  recorder.uiPromptStart("confirm", "Approve\n\u001b[31mfixture action\u001b[0m");
  now += 1000;
  recorder.toolExecutionUpdate("call", "confirm-tool");
  let read = readSubagentActivityFile(path, "dialog");
  assert.ok(read.ok);
  assert.equal(read.activity.phase, "blocked");
  assert.deepEqual(read.activity.uiPrompt, { kind: "confirm", title: "Approve fixture action" });
  assert.ok(read.activity.uiPrompt);
  let state = observeStatus(createStatusState({ source: "pi", startTimeMs: 0 }), {
    snapshot: "present", ...read.activity, activityLabel: read.activity.uiPrompt.title,
  }, now);
  const advanced = advanceStatusState(state, now);
  assert.equal(advanced.transition, "blocked");
  assert.match(formatStatusLine("Child", advanced.snapshot), /blocked.*Approve fixture action/);
  assert.equal(advanceStatusState(advanced.nextState, now + 600_000).transition, null);
  assert.equal(classifyStatus(advanced.nextState, now + 600_000).kind, "blocked");
  state = observeStatus(advanced.nextState, { snapshot: "missing" }, now);
  assert.equal(classifyStatus(state, now + 1000).kind, "blocked");
  recorder.uiPromptEnd();
  read = readSubagentActivityFile(path, "dialog");
  assert.ok(read.ok);
  assert.equal(read.activity.phase, "active");
  assert.equal(read.activity.activeScope, "tool");
  assert.equal(read.activity.uiPrompt, undefined);
  recorder.agentEndWaiting();
  recorder.uiPromptStart("custom");
  recorder.uiPromptEnd();
  read = readSubagentActivityFile(path, "dialog");
  assert.ok(read.ok);
  assert.equal(read.activity.phase, "waiting");
  recorder.sessionShutdown("reload");
});

test("an auto-exit native child remains usable after a provider reports cancellation as an error", async (t) => {
  const dir = mkdtempSync(join(tmpdir(), "pis-abort-status-"));
  const session = join(dir, "child.jsonl");
  const activity = join(dir, "activity.json");
  const release = join(dir, "release");
  const env: Record<string, string> = {};
  for (const key of Object.keys(process.env)) if (key.startsWith("PI_SUBAGENT_")) env[key] = "";
  Object.assign(env, {
    HOME: dir, PI_CODING_AGENT_DIR: dir, PI_SUBAGENT_RUN: JSON.stringify({ cli: "pi", runDir: dir, outputAfter: 0 }),
    PI_SUBAGENT_SESSION: session, PI_SUBAGENT_AUTO_EXIT: "1", PI_SUBAGENT_ID: "abort-status",
    PI_SUBAGENT_ACTIVITY_FILE: activity, RECOVERY_PROVIDER_LOG: join(dir, "provider.jsonl"), RECOVERY_CHILD_RELEASE: release,
  });
  const rpc = new RpcClient({
    cliPath: "/opt/homebrew/lib/node_modules/@earendil-works/pi-coding-agent/dist/bundle/cli.js", cwd: dir,
    args: ["--offline", "--no-extensions", "--no-skills", "--no-context-files", "--no-tools", "--no-prompt-templates",
      "--session", session, "--model", "recovery-test/child", "-e", join(import.meta.dirname, "fixtures/recovery-provider.ts"),
      "-e", join(import.meta.dirname, "../pi-extension/subagents/subagent-done.ts")], env,
  });
  t.after(async () => { await rpc.stop(); execFileSync("trash", [dir]); });
  await rpc.start();
  const interrupted = rpc.promptAndWait("RECOVERY_ABORT_AS_ERROR");
  const deadline = Date.now() + FIXTURE_WAIT_MS;
  while (!existsSync(release + ".waiting")) {
    assert.ok(Date.now() < deadline, "native provider must enter the held request");
    await setTimeout(FIXTURE_POLL_MS);
  }
  await rpc.abort();
  const events = await interrupted;
  assert.ok(events.some((event) => event.type === "agent_settled" && event.aborted));
  assert.equal(existsSync(join(dir, "completion.json")), false);
  assert.equal(JSON.parse(readFileSync(activity, "utf8")).phase, "waiting");
  writeFileSync(release, "release");
  const followup = await rpc.promptAndWait("Continue after cancellation");
  assert.ok(followup.some((event) => event.type === "agent_settled" && !event.aborted));
  assert.equal(JSON.parse(readFileSync(join(dir, "completion.json"), "utf8")).reason, "done");
  const artifacts = join(import.meta.dirname, "artifacts/program-status");
  mkdirSync(artifacts, { recursive: true });
  writeFileSync(join(artifacts, "cancellation.json"), JSON.stringify({ interrupted: events, followup, paidRequests: 0 }, null, 2) + "\n");
  writeFileSync(join(artifacts, "cancellation-session.jsonl"), readFileSync(session));
});
