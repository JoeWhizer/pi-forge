export {};

const values = new Map<string, string>();
Object.defineProperty(globalThis, "BroadcastChannel", { configurable: true, value: undefined });
Object.defineProperty(globalThis, "localStorage", {
  configurable: true,
  value: {
    getItem: (key: string): string | null => values.get(key) ?? null,
    setItem: (key: string, value: string): void => {
      values.set(key, value);
    },
    removeItem: (key: string): void => {
      values.delete(key);
    },
  },
});

const { addBackgroundSubagentRunToLists } =
  await import("../packages/client/src/store/session-store");

let failures = 0;
function assert(label: string, ok: boolean, detail?: string): void {
  if (ok) console.log(`PASS ${label}`);
  else {
    failures += 1;
    console.error(`FAIL ${label}${detail === undefined ? "" : `: ${detail}`}`);
  }
}

const parentSessionId = "parent-session-id";
const runId = "stable-async-run-id";
const byProject = {
  project: [
    {
      sessionId: parentSessionId,
      projectId: "project",
      isLive: true,
      workspacePath: "/workspace",
      lastActivityAt: "2026-01-01T00:00:00.000Z",
      createdAt: "2026-01-01T00:00:00.000Z",
      messageCount: 1,
      firstMessage: "start",
    },
  ],
};

const started = addBackgroundSubagentRunToLists(byProject, parentSessionId, runId);
const startedParent = started.project?.[0];
assert(
  "async launch receipt marks its stable parent/run before child discovery",
  startedParent?.backgroundSubagentRuns?.length === 1 &&
    startedParent.backgroundSubagentRuns[0]?.runId === runId &&
    startedParent.backgroundSubagentRuns[0]?.state === "running",
  JSON.stringify(startedParent),
);

const deduped = addBackgroundSubagentRunToLists(started, parentSessionId, runId);
assert(
  "repeated start receipt does not duplicate the stable run id",
  deduped.project?.[0]?.backgroundSubagentRuns?.length === 1,
  JSON.stringify(deduped.project?.[0]),
);

const unrelated = addBackgroundSubagentRunToLists(byProject, "other-parent", runId);
assert(
  "start receipt cannot attach activity by display name or another parent",
  unrelated === byProject,
);

if (failures > 0) process.exit(1);
console.log("PASS test-subagent-sidebar-state");
