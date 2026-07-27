export type ExternalSubagentRunState =
  | "queued"
  | "running"
  | "complete"
  | "failed"
  | "paused"
  | "stopped";

/**
 * Count status-file-confirmed background run states for sidebar indicators.
 * Paused and terminal runs remain visible as lifecycle status, but only
 * queued/running runs count as active spinner work.
 */
export function backgroundSubagentRunCounts(
  runs:
    | readonly {
        runId: string;
        state: ExternalSubagentRunState;
      }[]
    | undefined,
): { active: number; paused: number } {
  let active = 0;
  let paused = 0;
  for (const run of runs ?? []) {
    if (run.state === "queued" || run.state === "running") active += 1;
    else if (run.state === "paused") paused += 1;
  }
  return { active, paused };
}
