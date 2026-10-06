import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { cpSync, mkdirSync, mkdtempSync, renameSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { expandPromptTemplate, loadPromptTemplates } from "/opt/homebrew/lib/node_modules/@earendil-works/pi-coding-agent/dist/core/prompt-templates.js";

const root = fileURLToPath(new URL("../", import.meta.url));

test("workflow examples support opt-in installation, arguments, renaming, and removal", (t) => {
  const dir = mkdtempSync(join(tmpdir(), "pis-prompts-"));
  try {
    const agentDir = join(dir, "agent");
    const userPrompts = join(agentDir, "prompts");
    const projectPrompts = join(dir, ".pi/prompts");
    mkdirSync(userPrompts, { recursive: true });
    mkdirSync(projectPrompts, { recursive: true });
    const load = () => {
      const result = loadPromptTemplates({ cwd: dir, agentDir, promptPaths: [], includeDefaults: true });
      assert.deepEqual(result.diagnostics, []);
      return result.templates;
    };
    assert.deepEqual(load(), []);
    writeFileSync(join(userPrompts, "plan.md"), "User-owned planning instructions: $ARGUMENTS");
    assert.equal(expandPromptTemplate("/plan My project", load()), "User-owned planning instructions: My project");
    cpSync(join(root, "examples/prompts/iterate.md"), join(projectPrompts, "iterate.md"));
    const iterate = expandPromptTemplate('/iterate Fix "pagination bug"', load());
    assert.match(iterate, /fork: true/);
    assert.match(iterate, /Fix pagination bug/);
    assert.doesNotMatch(iterate, /\$ARGUMENTS/);
    cpSync(join(root, "examples/prompts/plan.md"), join(projectPrompts, "design.md"));
    const plan = expandPromptTemplate("/design Add dark mode", load());
    assert.match(plan, /Add dark mode/);
    assert.match(plan, /scout-context\.md/);
    assert.match(plan, /agent: "planner"/);
    renameSync(join(projectPrompts, "iterate.md"), join(projectPrompts, "focus.md"));
    assert.equal(expandPromptTemplate("/iterate Fix bug", load()), "/iterate Fix bug");
    assert.match(expandPromptTemplate("/focus Fix bug", load()), /fork: true/);
    execFileSync("trash", [join(projectPrompts, "focus.md")]);
    assert.equal(expandPromptTemplate("/focus Fix bug", load()), "/focus Fix bug");
    const artifacts = join(root, "test/artifacts/workflow-prompts");
    mkdirSync(artifacts, { recursive: true });
    writeFileSync(join(artifacts, "receipt.json"), JSON.stringify({ iterate, plan, paidRequests: 0 }, null, 2) + "\n");
    t.diagnostic(`Verification artifact: ${artifacts}/receipt.json`);
  } finally {
    execFileSync("trash", [dir]);
  }
});
