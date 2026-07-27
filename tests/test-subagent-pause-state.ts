import {
  PAUSE_CONFIRMATION_TIMEOUT_MS,
  backgroundSubagentRunCounts,
  pauseControlState,
} from "../packages/client/src/lib/subagent-control-state";

let failures = 0;
function assert(label: string, ok: boolean, detail?: string): void {
  if (ok) console.log(`PASS ${label}`);
  else {
    failures += 1;
    console.error(`FAIL ${label}${detail === undefined ? "" : `: ${detail}`}`);
  }
}

const runId = "pause-run";
const requestedAt = 1_000;
const parent = (state: "queued" | "running" | "complete" | "failed" | "paused" | "stopped") => [
  {
    sessionId: "parent",
    projectId: "project",
    isLive: true,
    workspacePath: "/workspace",
    lastActivityAt: "2026-01-01T00:00:00.000Z",
    createdAt: "2026-01-01T00:00:00.000Z",
    messageCount: 1,
    firstMessage: "parent",
    backgroundSubagentRuns: [{ runId, state }],
  },
];

const delayed = pauseControlState({
  action: "interrupt",
  targetRunId: runId,
  isError: false,
  requestedAt,
  now: requestedAt + 500,
  sessions: parent("running"),
});
const delayedCounts = backgroundSubagentRunCounts(parent("running")[0]?.backgroundSubagentRuns);
assert(
  "delayed pause request remains pending and retains the active spinner",
  delayed === "pending" && delayedCounts.active === 1 && delayedCounts.paused === 0,
  JSON.stringify({ delayed, delayedCounts }),
);

const acknowledged = pauseControlState({
  action: "interrupt",
  targetRunId: runId,
  isError: false,
  requestedAt,
  now: requestedAt + 2_000,
  sessions: parent("paused"),
});
const acknowledgedCounts = backgroundSubagentRunCounts(parent("paused")[0]?.backgroundSubagentRuns);
assert(
  "authoritative paused status clears the spinner and exposes paused lifecycle state",
  acknowledged === "paused" && acknowledgedCounts.active === 0 && acknowledgedCounts.paused === 1,
  JSON.stringify({ acknowledged, acknowledgedCounts }),
);

const failed = pauseControlState({
  action: "interrupt",
  targetRunId: runId,
  isError: true,
  requestedAt,
  now: requestedAt + 100,
  sessions: parent("running"),
});
const timedOut = pauseControlState({
  action: "interrupt",
  targetRunId: "stale-or-missing-run",
  isError: false,
  requestedAt,
  now: requestedAt + PAUSE_CONFIRMATION_TIMEOUT_MS,
  sessions: parent("paused"),
});
assert(
  "failed and unacknowledged/stale pause controls never report paused success",
  failed === "failed" && timedOut === "timeout",
  JSON.stringify({ failed, timedOut }),
);

const terminal = pauseControlState({
  action: "interrupt",
  targetRunId: runId,
  isError: false,
  requestedAt,
  now: requestedAt + 2_000,
  sessions: parent("complete"),
});
assert(
  "completion before a paused acknowledgement is not treated as a successful pause",
  terminal === "terminal",
  String(terminal),
);

if (failures > 0) process.exit(1);
console.log("PASS test-subagent-pause-state");
