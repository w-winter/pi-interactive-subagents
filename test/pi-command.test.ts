import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, realpathSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { resolvePiCommand } from "../pi-extension/subagents/launch-command.ts";

test("resolves the package's CLI through a symlink, but rejects other entries and absent metadata", (t) => {
  const root = realpathSync(mkdtempSync(join(tmpdir(), "pis-command-")));
  t.after(() => execFileSync("trash", [root]));
  const cli = join(root, "cli.mjs");
  const other = join(root, "other.mjs");
  writeFileSync(cli, "");
  writeFileSync(other, "");
  const manifest = join(root, "package.json");
  writeFileSync(manifest, JSON.stringify({ name: "@earendil-works/pi-coding-agent", bin: { pi: "cli.mjs" } }));
  const shim = join(root, "pi");
  symlinkSync(cli, shim);
  t.mock.property(process, "argv", [process.execPath, shim]);
  assert.deepEqual(resolvePiCommand(), [process.execPath, cli]);
  process.argv[1] = other;
  assert.throws(() => resolvePiCommand(), /Cannot identify.*Pi CLI/);
  process.argv = [process.execPath];
  assert.throws(() => resolvePiCommand(), /Cannot identify.*Pi CLI/);
  process.argv[1] = cli;
  writeFileSync(manifest, JSON.stringify({ name: "other-program", bin: { pi: "cli.mjs" } }));
  assert.throws(() => resolvePiCommand(), /Cannot identify.*Pi CLI/);
  writeFileSync(manifest, "{}");
  assert.throws(() => resolvePiCommand(), /Cannot identify.*Pi CLI/);
  writeFileSync(manifest, "{");
  assert.throws(() => resolvePiCommand(), SyntaxError);
});

test("compiled Bun and Node SEA hosts relaunch the binary without a script argument", (t) => {
  const binary = "/a directory/renamed-pi";
  t.mock.property(process, "execPath", binary);
  t.mock.property(process, "versions", { ...process.versions, bun: "1.4.4" });
  t.mock.property(process, "argv", [binary, "/$bunfs/root/pi"]);
  t.mock.method(process, "getBuiltinModule", () => { throw new Error("Bun cannot load node:sea"); });
  assert.deepEqual(resolvePiCommand(), [binary]);
  process.argv[1] = "B:\\~BUN\\root\\pi.exe";
  assert.deepEqual(resolvePiCommand(), [binary]);
  t.mock.restoreAll();
  t.mock.property(process, "execPath", binary);
  t.mock.property(process, "argv", [binary, binary]);
  t.mock.method(process, "getBuiltinModule", () => ({ isSea: () => true }));
  assert.deepEqual(resolvePiCommand(), [binary]);
});
