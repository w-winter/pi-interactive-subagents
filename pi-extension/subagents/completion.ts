import { setTimeout } from "node:timers/promises";
import {
  captureOutput, captureShellOutcome, observeActor, publishOutcome, readClaim, readOutcome,
  cancelUnstarted, type RunRecord, type RunOutcome, type ProcessClaim,
} from "./run-records.ts";

export type RunObservation = { kind: "pending" } | { kind: "suppressed" } | { kind: "outcome"; outcome: RunOutcome };

/** Read retained evidence; claimMissing runs only for an absent claim. Evidence/query/publication failures throw. */
// oxlint-disable-next-line sonarjs/cognitive-complexity -- Claim, semantic outcome, shell status and actor lifetime have one ordered precedence decision.
export function observeRun(run: RunRecord, closedByOperator = false, claimMissing: (() => ProcessClaim) | null = null): RunObservation {
  let claim = readClaim(run);
  if (!claim && claimMissing) claim = claimMissing();
  if (!claim && closedByOperator) claim = cancelUnstarted(run, "operator_close");
  if (!claim) return { kind: "pending" };
  if (claim.kind === "not_started") {
    if (claim.cause === "dispatch_failed") return { kind: "suppressed" };
    return { kind: "outcome", outcome: publishOutcome(run, {
      id: run.id, recordedAt: claim.observedAt,
      reason: claim.cause === "operator_close" ? "quit" : "interrupted",
      output: run.launch.kind === "claude" ? { cli: "claude", text: null, transcriptPath: null } : { cli: "pi", text: null },
    }) };
  }
  const outcome = readOutcome(run);
  if (outcome) return { kind: "outcome", outcome };
  const shell = captureShellOutcome(run);
  if (shell) return { kind: "outcome", outcome: shell };
  const live = observeActor(claim.executor) === "live" || observeActor(claim.supervisor) === "live";
  // Producers can publish during process queries; their outcome takes precedence.
  const completed = readOutcome(run) ?? captureShellOutcome(run);
  if (completed) return { kind: "outcome", outcome: completed };
  if (live) return { kind: "pending" };
  return { kind: "outcome", outcome: publishOutcome(run, {
    id: run.id, recordedAt: Date.now(), reason: closedByOperator ? "quit" : "interrupted", output: captureOutput(run),
  }) };
}

/** Await retained evidence, reporting each unavailable transition while polling; cancellation only detaches. */
// oxlint-disable-next-line sonarjs/cognitive-complexity -- This loop jointly owns cancellation and evidence/terminal availability transitions.
export async function pollForExit(run: RunRecord, signal: AbortSignal, options: {
  interval: number; onTick: () => void; onUnavailable: () => void; operatorClosed: (() => Promise<boolean>) | null;
  claimMissing: (() => ProcessClaim) | null;
}): Promise<Exclude<RunObservation, { kind: "pending" }>> {
  let closedByOperator = false;
  let probeUnavailable = false;
  let evidenceUnavailable = false;
  for (;;) {
    signal.throwIfAborted();
    try {
      const observed = observeRun(run, closedByOperator, options.claimMissing);
      if (evidenceUnavailable) console.info(`[subagents:recovery] ${JSON.stringify({ id: run.id, event: "available" })}`);
      evidenceUnavailable = false;
      if (observed.kind !== "pending") return observed;
    } catch (error) {
      if (!evidenceUnavailable) {
        console.warn(`[subagents:recovery] ${JSON.stringify({ id: run.id, event: "unavailable", error: error instanceof Error ? error.message : "Error" })}`);
        options.onUnavailable();
      }
      evidenceUnavailable = true;
    }
    if (!evidenceUnavailable && options.operatorClosed && !closedByOperator) {
      try {
        closedByOperator = await options.operatorClosed();
        if (probeUnavailable) console.info(`[subagents:terminal-lifecycle] ${JSON.stringify({ id: run.id, event: "probe_recovered" })}`);
        probeUnavailable = false;
        if (closedByOperator) continue;
      } catch (error) {
        if (!probeUnavailable) console.warn(`[subagents:terminal-lifecycle] ${JSON.stringify({ id: run.id, event: "probe_failed", error: error instanceof Error ? error.name : "Error" })}`);
        probeUnavailable = true;
      }
    }
    signal.throwIfAborted();
    options.onTick();
    await setTimeout(options.interval, undefined, { signal });
  }
}
