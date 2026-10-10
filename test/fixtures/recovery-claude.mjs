#!/usr/bin/env node
import { writeFileSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { join } from "node:path";
import { setTimeout } from "node:timers/promises";

const root = process.env.RECOVERY_FIXTURE_ROOT;
if (!root) throw new Error("Missing isolated Claude root");
const transcript = join(root, "claude-transcript.jsonl");
writeFileSync(join(root, "claude-arguments.json"), JSON.stringify(process.argv.slice(2)));
const count = process.env.RECOVERY_CLAUDE_INTERACTIVE === "1" ? 2 : 1;
writeFileSync(transcript, Array.from({ length: count }, () => JSON.stringify({ type: "user", message: { content: "Fixture input" } })).join("\n") + "\n");
const hook = process.env.RECOVERY_CLAUDE_HOOK;
if (!hook) throw new Error("Missing real Stop hook path");
const result = spawnSync("/bin/bash", [hook], {
  input: JSON.stringify({ stop_hook_active: false, transcript_path: transcript, last_assistant_message: "CLAUDE_RECOVERY_ANSWER" }), encoding: "utf8",
});
if (result.status !== 0) throw new Error("Real Stop hook failed: " + result.stderr);
const guarded = spawnSync("/bin/bash", [hook], {
  input: JSON.stringify({ stop_hook_active: true }), encoding: "utf8",
});
if (guarded.status !== 0) throw new Error("Real Stop guard failed: " + guarded.stderr);
writeFileSync(join(root, "claude-response-ready"), JSON.stringify({ pid: process.pid, ppid: process.ppid }));
// Real autonomous Claude remains idle after Stop. The test controls closure through its private process group.
for (;;) await setTimeout(1000);
