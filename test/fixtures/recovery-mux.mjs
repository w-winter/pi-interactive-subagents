#!/usr/bin/env node
import { appendFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { spawn } from "node:child_process";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { setTimeout } from "node:timers/promises";

const root = process.env.RECOVERY_FIXTURE_ROOT;
if (!root) throw new Error("Missing fixture terminal root");
const args = process.argv.slice(2);
appendFileSync(join(root, "calls.jsonl"), JSON.stringify(args) + "\n");
const value = (name) => args[args.indexOf(name) + 1];
const handle = value("--terminal");
const records = join(root, "terminals");
mkdirSync(records, { recursive: true });
const actorFile = join(records, `${handle}.json`);
let result;
switch (args[1]) {
  case "create": {
    const sequence = join(root, "sequence");
    const next = existsSync(sequence) ? Number(readFileSync(sequence, "utf8")) + 1 : 1;
    writeFileSync(sequence, String(next));
    result = { terminal: { handle: `fixture-child-${next}`, surface: "visible" } };
    break;
  }
  case "send": {
    if (existsSync(join(root, "reject"))) { result = { send: { accepted: false } }; break; }
    const command = value("--text");
    if (command.startsWith("bash ")) {
      appendFileSync(join(root, "dispatch.jsonl"), JSON.stringify({ handle,
        parentEntries: existsSync(process.env.RECOVERY_PARENT_FILE) ? readFileSync(process.env.RECOVERY_PARENT_FILE, "utf8") : "" }) + "\n");
      if (existsSync(join(root, "hold-dispatch"))) {
        appendFileSync(join(root, "pending-command.jsonl"), JSON.stringify({ command, handle }) + "\n");
        result = { send: { accepted: true } };
        break;
      }
      const helper = fileURLToPath(new URL("recovery-pty.py", import.meta.url));
      const child = spawn("uv", ["run", "--no-project", "--offline", "--python", "/usr/bin/python3", helper,
        command, actorFile, join(records, `${handle}.output`)], { detached: true, stdio: "ignore" });
      child.unref();
      if (existsSync(join(root, "ambiguous-send"))) {
        const entries = readFileSync(process.env.RECOVERY_PARENT_FILE, "utf8").split("\n").filter(Boolean).map((line) => JSON.parse(line));
        const run = entries.findLast((entry) => entry.type === "custom" && entry.customType === "subagent-run").data;
        const deadline = Date.now() + 30000;
        while (!existsSync(join(run.runDir, "process.json"))) {
          if (Date.now() >= deadline) throw new Error("Fixture launcher did not claim before transport failure");
          await setTimeout(20);
        }
        console.log(JSON.stringify({ ok: false, result: {} }));
        process.exit(0);
      }
    }
    result = { send: { accepted: true } };
    break;
  }
  case "close": {
    if (existsSync(actorFile)) {
      const actor = JSON.parse(readFileSync(actorFile, "utf8"));
      try { process.kill(-actor.pid, "SIGHUP"); } catch (error) { if (error.code !== "ESRCH") throw error; }
    }
    writeFileSync(join(records, `${handle}.closed`), "closed");
    result = {};
    break;
  }
  case "show":
    result = { terminal: { worktreeId: "fixture-worktree", executionHostId: "local" } };
    if (existsSync(join(records, `${handle}.closed`))) result.terminal.exitCause = { kind: "operator_close" };
    break;
  case "read":
    result = { terminal: { source: "screen", tail: [existsSync(join(records, `${handle}.output`))
      ? readFileSync(join(records, `${handle}.output`), "utf8") : "$ "] } };
    break;
  default: throw new Error("Unexpected fixture terminal operation");
}
console.log(JSON.stringify({ ok: true, result }));
