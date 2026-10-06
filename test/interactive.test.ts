import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { RpcClient } from "/opt/homebrew/lib/node_modules/@earendil-works/pi-coding-agent/dist/index.js";

const root = fileURLToPath(new URL("../", import.meta.url));

test("an interactive child waits after a response and accepts another turn", async (t) => {
  const dir = mkdtempSync(join(tmpdir(), "pis-interactive-"));
  const session = join(dir, "child.jsonl");
  const activity = join(dir, "activity.json");
  const rpc = new RpcClient({
    cliPath: "/opt/homebrew/lib/node_modules/@earendil-works/pi-coding-agent/dist/bundle/cli.js",
    cwd: dir,
    args: [
      "--offline", "--no-extensions", "--no-skills", "--no-context-files", "--no-tools",
      "--session", session, "--model", "guard-test/astra",
      "-e", join(root, "test/fixtures/model-guard-provider.ts"),
      "-e", join(root, "pi-extension/subagents/subagent-done.ts"),
    ],
    env: {
      PI_CODING_AGENT_DIR: dir, PI_SUBAGENT_SESSION: session, PI_SUBAGENT_AUTO_EXIT: "0",
      PI_SUBAGENT_ID: "interactive-test", PI_SUBAGENT_ACTIVITY_FILE: activity,
    },
  });
  try {
    await rpc.start();
    const responses: string[] = [];
    for (const task of ["First request", "Follow-up request"]) {
      await rpc.promptAndWait(task);
      const response = await rpc.getLastAssistantText();
      assert.ok(response);
      responses.push(response);
      assert.equal(existsSync(`${session}.exit`), false);
      assert.equal(JSON.parse(readFileSync(activity, "utf8")).phase, "waiting");
    }
    const artifacts = join(root, "test/artifacts/interactive");
    mkdirSync(artifacts, { recursive: true });
    writeFileSync(join(artifacts, "receipt.json"), JSON.stringify({ responses, phase: "waiting", paidRequests: 0 }, null, 2) + "\n");
    writeFileSync(join(artifacts, "session.jsonl"), readFileSync(session));
    t.diagnostic(`Verification artifacts: ${artifacts}`);
  } finally {
    await rpc.stop();
    execFileSync("trash", [dir]);
  }
});
