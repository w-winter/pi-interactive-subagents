import { execFile, execFileSync } from "node:child_process";
import { promisify } from "node:util";
import { Type, type Static, type TSchema } from "@sinclair/typebox";
import { Value } from "@sinclair/typebox/value";

const execFileAsync = promisify(execFile);
const Handle = Type.String({ minLength: 1 });
const Parent = Type.Object({ terminal: Type.Object({ worktreeId: Handle, executionHostId: Type.Literal("local") }) });
const Created = Type.Object({ terminal: Type.Object({ handle: Handle, surface: Type.String() }) });
const Sent = Type.Object({ send: Type.Object({ accepted: Type.Literal(true) }) });
const Screen = Type.Object({ terminal: Type.Object({ source: Type.Literal("screen"), tail: Type.Array(Type.String()) }) });

/** Target the current Orca runtime: honor `ORCA_CLI_COMMAND`, use `orca-dev` in a development session, and otherwise use `orca`. */
export function cliCommand(): string {
  if (process.env.ORCA_CLI_COMMAND) return process.env.ORCA_CLI_COMMAND;
  if (process.env.ORCA_DEV_REPO_ROOT) return "orca-dev";
  return "orca";
}

function currentHandle(): string {
  const handle = process.env.ORCA_TERMINAL_HANDLE;
  if (!handle) throw new Error("ORCA_TERMINAL_HANDLE not set");
  return handle;
}

function decode<T extends TSchema>(output: string, schema: T): Static<T> {
  const envelope = Type.Object({ ok: Type.Literal(true), result: Type.Unknown() });
  const value: unknown = JSON.parse(output);
  if (!Value.Check(envelope, value)) {
    const issues = [...Value.Errors(envelope, value)].map((issue) => `${issue.path}: ${issue.message}`).join("; ");
    throw new Error(`Orca returned an unsuccessful or unexpected response: ${issues}`);
  }
  const result = value.result;
  if (!Value.Check(schema, result)) {
    const issues = [...Value.Errors(schema, result)].map((issue) => `${issue.path}: ${issue.message}`).join("; ");
    throw new Error(`Orca returned an unexpected result: ${issues}`);
  }
  return result;
}

function call<T extends TSchema>(args: string[], schema: T): Static<T> {
  return decode(execFileSync(cliCommand(), ["terminal", ...args, "--json"], { encoding: "utf8" }), schema);
}

/** Create a visible terminal tab in the caller's local worktree without taking focus. */
export function createTab(name: string): string {
  const parent = call(["show", "--terminal", currentHandle()], Parent).terminal;
  const child = call(["create", "--worktree", `id:${parent.worktreeId}`, "--title", name], Created).terminal;
  if (child.surface !== "visible") {
    closeTab(child.handle);
    throw new Error("Orca could not create a visible subagent tab.");
  }
  return child.handle;
}

export function renameTab(title: string): void {
  call(["rename", "--terminal", currentHandle(), "--title", title], Type.Object({}));
}

export function sendCommand(handle: string, command: string): void {
  call(["send", "--terminal", handle, "--text", command, "--enter"], Sent);
}

/** Send Escape without Enter to interrupt the current Pi turn. */
export function sendEscape(handle: string): void {
  call(["send", "--terminal", handle, "--text", "\u001b"], Sent);
}

export function readScreen(handle: string, lines: number): string {
  return call(["read", "--terminal", handle, "--screen", "--limit", String(lines)], Screen).terminal.tail.join("\n");
}

export async function readScreenAsync(handle: string, lines: number): Promise<string> {
  const { stdout } = await execFileAsync(cliCommand(), [
    "terminal", "read", "--terminal", handle, "--screen", "--limit", String(lines), "--json",
  ], { encoding: "utf8" });
  return decode(stdout, Screen).terminal.tail.join("\n");
}

/** Close the addressed terminal pane while leaving sibling splits in its tab open. */
export function closeTab(handle: string): void {
  call(["close", "--terminal", handle], Type.Object({}));
}
