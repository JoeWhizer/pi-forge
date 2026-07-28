import type { SubagentFleetRun, SubagentFleetState } from "./api-client/types";

export interface SubagentFleetGroup {
  /** Stable parent session id, or undefined for artifacts whose parent is unavailable. */
  parentSessionId: string | undefined;
  runs: SubagentFleetRun[];
}

/** Group runs by the explicit parent id without inferring identity from labels or timestamps. */
export function groupSubagentFleetRuns(runs: readonly SubagentFleetRun[]): SubagentFleetGroup[] {
  const groups = new Map<string | undefined, SubagentFleetRun[]>();
  for (const run of runs) {
    const current = groups.get(run.parentSessionId);
    if (current === undefined) groups.set(run.parentSessionId, [run]);
    else current.push(run);
  }
  return Array.from(groups, ([parentSessionId, groupedRuns]) => ({
    parentSessionId,
    runs: groupedRuns,
  }));
}

export function isActiveSubagentFleetState(state: SubagentFleetState): boolean {
  return state === "queued" || state === "running";
}

/** Keep arbitrary lifecycle ids from expanding a fleet card beyond the viewport. */
export function truncateSubagentFleetRunId(runId: string, maximumLength = 80): string {
  if (runId.length <= maximumLength) return runId;
  return `${runId.slice(0, maximumLength - 1)}…`;
}

export function formatSubagentDuration(
  durationMs: number | undefined,
  startedAt: number | undefined,
  endedAt: number | undefined,
  now = Date.now(),
): string | undefined {
  let milliseconds = durationMs;
  if (startedAt !== undefined) milliseconds = Math.max(0, (endedAt ?? now) - startedAt);
  if (milliseconds === undefined || !Number.isFinite(milliseconds)) return undefined;
  const seconds = Math.max(0, Math.floor(milliseconds / 1000));
  if (seconds < 60) return `${seconds}s`;
  const minutes = Math.floor(seconds / 60);
  const remainingSeconds = seconds % 60;
  if (minutes < 60) return `${minutes}m ${remainingSeconds}s`;
  const hours = Math.floor(minutes / 60);
  return `${hours}h ${minutes % 60}m`;
}
