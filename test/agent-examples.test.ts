import assert from "node:assert/strict";
import { mkdirSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import test from "node:test";
import { __test__ } from "../pi-extension/subagents/index.ts";
import { withIsolatedAgentEnv } from "./helpers/agent-fixtures.ts";

test("shipped agent examples become available when installed in an active directory", async () => {
  const examples = join(import.meta.dirname, "../examples/agents");
  const files = readdirSync(examples).filter(file => file.endsWith(".md")).sort();
  assert.ok(files.length > 0, "the example distribution must contain definitions");
  const installations: Array<{ file: string; name: string; source: string }> = [];
  for (const file of files) {
    for (const source of ["global", "project"] as const) {
      await withIsolatedAgentEnv(({ globalAgentsDir, projectAgentsDir }) => {
        assert.deepEqual(__test__.discoverAgentDefinitions(), []);
        const destination = join(source === "global" ? globalAgentsDir : projectAgentsDir, file);
        writeFileSync(destination, readFileSync(join(examples, file)));
        const definitions = __test__.discoverAgentDefinitions();
        assert.equal(definitions.length, 1);
        const definition = definitions[0];
        assert.equal(definition.source, source);
        assert.deepEqual(__test__.loadAgentDefaults(definition.name), definition);
        installations.push({ file, name: definition.name, source });
      });
    }
  }
  const artifacts = join(import.meta.dirname, "artifacts/agent-examples");
  mkdirSync(artifacts, { recursive: true });
  writeFileSync(join(artifacts, "receipt.json"), JSON.stringify({ installations, node: process.version, paidRequests: 0 }, null, 2));
});
