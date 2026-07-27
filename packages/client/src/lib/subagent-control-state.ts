import type { UnifiedSession } from "./api-client";

export const PAUSE_CONFIRMATION_TIMEOUT_MS = 10_000;

type ExternalRunState = "queued" | "running" | "complete" | "failed" | "paused" | "stopped";

export type PauseControlState = "pending" | "paused" | "failed" | "timeout" | "terminal";

export interface PauseControlInput {
  action: unknown;
  targetRunId: unknown;
  isError: boolean;
  requestedAt?: number;
  now: number;
  sessions: readonly UnifiedSession[];
}

/**
 * Count only status-file-confirmed active runs as spinner work. A paused run
 * remains visible to the parent, but it must never keep an activity spinner.
 */
export function backgroundSubagentRunCounts(
  runs: readonly { runId: string; state: "queued" | "running" | "paused" }[] | undefined,
): { active: number; paused: number } {
  let active = 0;
  let paused = 0;
  for (const run of runs ?? []) {
    if (run.state === "queued" || run.state === "running") active += 1;
    else if (run.state === "paused") paused += 1;
  }
  return { active, paused };
}

function stateForExactRun(
  targetRunId: string,
  sessions: readonly UnifiedSession[],
): ExternalRunState | undefined {
  for (const session of sessions) {
    for (const run of session.backgroundSubagentRuns ?? []) {
      if (run.runId === targetRunId) return run.state;
    }
    if (session.runId === targetRunId && session.externalState !== undefined) {
      return session.externalState;
    }
  }
  return undefined;
}

/**
 * An interrupt result is only a request accepted by pi-subagents 0.37. Treat
 * it as paused only after Forge observes the matching status.json transition.
 * Exact IDs are intentional: a missing or stale control target must not claim
 * another run's paused state.
 */
export function pauseControlState(input: PauseControlInput): PauseControlState | undefined {
  if (input.action !== "interrupt") return undefined;
  if (input.isError) return "failed";

  const targetRunId =
    typeof input.targetRunId === "string" && input.targetRunId.trim().length > 0
      ? input.targetRunId.trim()
      : undefined;
  const state =
    targetRunId === undefined ? undefined : stateForExactRun(targetRunId, input.sessions);
  if (state === "paused") return "paused";
  if (state === "complete" || state === "failed" || state === "stopped") return "terminal";

  const timedOut =
    input.requestedAt !== undefined &&
    input.now - input.requestedAt >= PAUSE_CONFIRMATION_TIMEOUT_MS;
  return timedOut ? "timeout" : "pending";
}
