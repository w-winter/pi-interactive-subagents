import { existsSync, readFileSync, rmSync } from "node:fs";
import { setTimeout } from "node:timers/promises";
import { getMuxBackend, interpretExitSidecar, readScreenAsync } from "./mux.ts";
import { isTabClosed } from "./orca.ts";

export interface PollResult {
  /** How the subagent exited. A confirmed operator close is quit. */
  reason: "done" | "ping" | "sentinel" | "error" | "quit";
  /** Shell exit code (from sentinel). 0 for file-based exits and operator closure. */
  exitCode: number;
  /** Ping data if reason is "ping" */
  ping?: { name: string; message: string };
  /** Error message if reason is "error" (auto-retry exhausted, provider overload, etc.) */
  errorMessage?: string;
}

type ExitFileRead =
  | { kind: "missing" }
  | { kind: "result"; result: PollResult }
  | { kind: "unreadable"; file: string; error: Error };

function readExitFile(file: string): ExitFileRead {
  try {
    if (!existsSync(file)) return { kind: "missing" };
    const data: unknown = JSON.parse(readFileSync(file, "utf8"));
    const result = interpretExitSidecar(data);
    rmSync(file, { force: true });
    return { kind: "result", result };
  } catch (error) {
    return { kind: "unreadable", file, error: error instanceof Error ? error : new Error(String(error)) };
  }
}

function readCompletionFiles(options: { sessionFile?: string; sentinelFile?: string }): PollResult | null {
  if (options.sessionFile) {
    const read = readExitFile(`${options.sessionFile}.exit`);
    if (read.kind === "result") return read.result;
    if (read.kind === "unreadable") {
      console.warn(`[subagents:completion-file] ${JSON.stringify({
        file: read.file, error: read.error.name,
      })}`);
    }
  }
  if (options.sentinelFile && existsSync(options.sentinelFile)) {
    return { reason: "sentinel", exitCode: 0 };
  }
  return null;
}

type OrcaTerminalState = "open" | "closed" | "unavailable";

async function readOrcaTerminalState(surface: string, previous: OrcaTerminalState): Promise<OrcaTerminalState> {
  try {
    const closed = await isTabClosed(surface);
    if (previous === "unavailable") {
      console.info(`[subagents:terminal-lifecycle] ${JSON.stringify({ surface, event: "probe_recovered" })}`);
    }
    return closed ? "closed" : "open";
  } catch (error) {
    if (previous !== "unavailable") {
      console.warn(`[subagents:terminal-lifecycle] ${JSON.stringify({
        surface, event: "probe_failed", error: error instanceof Error ? error.message : String(error),
      })}`);
    }
    return "unavailable";
  }
}

/** Poll completion files, shell sentinels, and Orca operator closure. Abort rejects; failed lifecycle queries keep polling. */
export async function pollForExit(
  surface: string,
  signal: AbortSignal,
  options: {
    interval: number;
    sessionFile?: string;
    sentinelFile?: string;
    onTick?: (elapsed: number) => void;
  },
): Promise<PollResult> {
  const start = Date.now();
  const backend = getMuxBackend();
  let terminalState: OrcaTerminalState = "open";

  for (;;) {
    signal.throwIfAborted();

    const completion = readCompletionFiles(options);
    if (completion) return completion;

    try {
      const screen = await readScreenAsync(surface, 5);
      const match = screen.match(/__SUBAGENT_DONE_(\d+)__/);
      if (match) return { reason: "sentinel", exitCode: parseInt(match[1], 10) };
    } catch {}

    if (backend === "orca") {
      // Closed Orca handles retain metadata and may still return archived screen output.
      terminalState = await readOrcaTerminalState(surface, terminalState);
    }

    signal.throwIfAborted();
    // Completion written during terminal I/O takes precedence over operator closure.
    const lateCompletion = readCompletionFiles(options);
    if (lateCompletion) return lateCompletion;
    if (terminalState === "closed") return { reason: "quit", exitCode: 0 };

    options.onTick?.(Math.floor((Date.now() - start) / 1000));

    await setTimeout(options.interval, undefined, { signal });
  }
}
