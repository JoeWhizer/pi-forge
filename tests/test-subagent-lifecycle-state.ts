import { backgroundSubagentRunCounts } from "../packages/client/src/lib/subagent-run-state";

let failures = 0;
function assert(label: string, ok: boolean, detail?: string): void {
  if (ok) console.log(`PASS ${label}`);
  else {
    failures += 1;
    console.error(`FAIL ${label}${detail === undefined ? "" : `: ${detail}`}`);
  }
}

const counts = backgroundSubagentRunCounts([
  { runId: "queued-run", state: "queued" },
  { runId: "running-run", state: "running" },
  { runId: "paused-run", state: "paused" },
  { runId: "complete-run", state: "complete" },
  { runId: "failed-run", state: "failed" },
  { runId: "stopped-run", state: "stopped" },
]);
assert(
  "only queued and running subagents count as active work",
  counts.active === 2,
  JSON.stringify(counts),
);
assert(
  "paused status remains a passive lifecycle indicator without active work",
  counts.paused === 1 && counts.active === 2,
  JSON.stringify(counts),
);

const terminalOnly = backgroundSubagentRunCounts([
  { runId: "complete-run", state: "complete" },
  { runId: "failed-run", state: "failed" },
  { runId: "stopped-run", state: "stopped" },
]);
assert(
  "stopped and other terminal states remain non-active",
  terminalOnly.active === 0 && terminalOnly.paused === 0,
  JSON.stringify(terminalOnly),
);

if (failures > 0) process.exit(1);
console.log("PASS test-subagent-lifecycle-state");
