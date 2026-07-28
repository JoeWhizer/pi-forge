import type {
  SubagentFleetRun,
  SubagentFleetState,
  SubagentSupervisorRequest,
} from "./api-client/types";

export interface SubagentFleetGroup {
  /** Stable parent session id, or undefined for artifacts whose parent is unavailable. */
  parentSessionId: string | undefined;
  runs: SubagentFleetRun[];
}

export interface SubagentFleetNavigationGuard {
  start: () => number | undefined;
  isCurrent: (token: number) => boolean;
  finish: (token: number) => void;
  invalidate: () => void;
}

/**
 * Invalidates async child-session navigation when its fleet view closes.
 * A token prevents a completion from an unmounted view affecting a later reopen.
 */
export function createSubagentFleetNavigationGuard(): SubagentFleetNavigationGuard {
  let generation = 0;
  let inFlight = false;
  return {
    start: () => {
      if (inFlight) return undefined;
      inFlight = true;
      generation += 1;
      return generation;
    },
    isCurrent: (token) => inFlight && token === generation,
    finish: (token) => {
      if (token === generation) inFlight = false;
    },
    invalidate: () => {
      generation += 1;
      inFlight = false;
    },
  };
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

/** Clean only hides finished runs locally; paused runs remain visible for follow-up. */
export function isCleanableSubagentFleetState(state: SubagentFleetState): boolean {
  return state === "complete" || state === "failed" || state === "stopped";
}

export function filterCleanedSubagentFleetRuns(
  runs: readonly SubagentFleetRun[],
  hiddenRunIds: ReadonlySet<string>,
): SubagentFleetRun[] {
  return runs.filter((run) => !hiddenRunIds.has(run.runId));
}

/**
 * A reply becomes cleanable only after the browser has received the accepted
 * reply response, or when the persisted native projection is terminal.
 * Explicit decisions are Forge-classified replies, never text inference.
 */
export function isCleanableSubagentSupervisorRequest(
  request: Pick<SubagentSupervisorRequest, "status" | "decision">,
  replySent = false,
): boolean {
  return (
    replySent ||
    request.status === "answered" ||
    request.status === "expired" ||
    request.decision === "approved" ||
    request.decision === "rejected"
  );
}

export function filterCleanedSubagentSupervisorRequests(
  requests: readonly SubagentSupervisorRequest[],
  hiddenRequestIds: ReadonlySet<string>,
): SubagentSupervisorRequest[] {
  return requests.filter((request) => !hiddenRequestIds.has(request.requestId));
}

/** Fleet starts compact at both hierarchy levels; explicit user toggles live in the store. */
export function shouldExpandSubagentFleetRuns(_runs: readonly SubagentFleetRun[]): boolean {
  return false;
}

export function shouldExpandSubagentFleetRun(_run: SubagentFleetRun): boolean {
  return false;
}

/** pi-subagents supports irreversible stop requests only for running async runs. */
export function isStoppableSubagentFleetRun(run: SubagentFleetRun): boolean {
  return run.state === "running";
}

/** Preserve explicit parent/run collapse choices while fleet polling replaces lifecycle rows. */
export function toggleSubagentFleetExpanded(
  expanded: Readonly<Record<string, boolean>>,
  key: string,
  defaultExpanded: boolean,
): Record<string, boolean> {
  return { ...expanded, [key]: !(expanded[key] ?? defaultExpanded) };
}

/** A lifecycle artifact is not navigable until normal session discovery resolves it. */
export function isSubagentFleetChildSessionDiscovered(
  sessionId: string | undefined,
  discoveredSessionIds: ReadonlySet<string>,
): boolean {
  return sessionId !== undefined && discoveredSessionIds.has(sessionId);
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
