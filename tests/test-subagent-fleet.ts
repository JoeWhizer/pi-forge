import { mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { randomUUID } from "node:crypto";
import {
  createSubagentFleetNavigationGuard,
  filterCleanedSubagentFleetRuns,
  formatSubagentDuration,
  groupSubagentFleetRuns,
  isSubagentFleetChildSessionDiscovered,
  shouldExpandSubagentFleetRun,
  shouldExpandSubagentFleetRuns,
  truncateSubagentFleetRunId,
} from "../packages/client/src/lib/subagent-fleet";
import type { SubagentFleetRun } from "../packages/client/src/lib/api-client/types";

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
let failures = 0;
function assert(label: string, ok: boolean, detail?: string): void {
  if (ok) console.log(`PASS ${label}`);
  else {
    failures += 1;
    console.error(`FAIL ${label}${detail === undefined ? "" : `: ${detail}`}`);
  }
}

async function writeSession(path: string, id: string): Promise<void> {
  await mkdir(dirname(path), { recursive: true });
  await writeFile(
    path,
    `${JSON.stringify({
      type: "session",
      version: 1,
      id,
      timestamp: new Date().toISOString(),
      cwd: tmpdir(),
    })}\n`,
    "utf8",
  );
}

async function main(): Promise<void> {
  process.env.NODE_ENV = "test";
  const external = (await import(
    resolve(repoRoot, "packages/server/dist/subagents-external.js")
  )) as {
    SUBAGENTS_ASYNC_DIR: string;
    SUBAGENTS_RESULTS_DIR: string;
    listExternalSubagentFleetRuns: (forceRefresh?: boolean) => Promise<SubagentFleetRun[]>;
    _hasExternalSubagentFleetRunCacheEntryForTests: (root: string) => boolean;
  };

  const activeRoot = `fleet-active-${randomUUID()}`;
  const failedRoot = `fleet-failed-${randomUUID()}`;
  const malformedRoot = `fleet-malformed-${randomUUID()}`;
  const processFailedRoot = `fleet-process-failed-${randomUUID()}`;
  // These collide in the 500-character prefix formerly used by the server.
  const longRunIdPrefix = `stable-run-${"r".repeat(500)}`;
  const activeRunId = `${longRunIdPrefix}-active`;
  const failedRunId = `${longRunIdPrefix}-failed`;
  const processFailedRunId = `${longRunIdPrefix}-exit-1`;
  const parentSessionId = randomUUID();
  const activeChildSessionId = randomUUID();
  const failedChildSessionId = randomUUID();
  const fixtureDir = join(tmpdir(), `pi-forge-fleet-fixture-${randomUUID()}`);
  const parentPath = join(fixtureDir, "parent.jsonl");
  const activeChildPath = join(fixtureDir, "active-child.jsonl");
  const failedChildPath = join(fixtureDir, "failed-child.jsonl");

  const cleanupPaths = [
    join(external.SUBAGENTS_ASYNC_DIR, activeRoot),
    join(external.SUBAGENTS_ASYNC_DIR, failedRoot),
    join(external.SUBAGENTS_ASYNC_DIR, malformedRoot),
    join(external.SUBAGENTS_ASYNC_DIR, processFailedRoot),
    join(external.SUBAGENTS_RESULTS_DIR, `${failedRoot}.json`),
    join(external.SUBAGENTS_RESULTS_DIR, `${processFailedRoot}.json`),
    fixtureDir,
  ];

  try {
    await Promise.all([
      writeSession(parentPath, parentSessionId),
      writeSession(activeChildPath, activeChildSessionId),
      writeSession(failedChildPath, failedChildSessionId),
    ]);
    await mkdir(join(external.SUBAGENTS_ASYNC_DIR, activeRoot), { recursive: true });
    await writeFile(
      join(external.SUBAGENTS_ASYNC_DIR, activeRoot, "status.json"),
      JSON.stringify({
        runId: activeRunId,
        sessionId: parentPath,
        mode: "single",
        state: "running",
        startedAt: 1_000,
        lastActivityAt: 2_000,
        steps: [
          {
            agent: "worker",
            status: "running",
            model: "provider/model",
            sessionFile: activeChildPath,
            startedAt: 1_100,
          },
        ],
      }),
      "utf8",
    );

    await mkdir(join(external.SUBAGENTS_ASYNC_DIR, failedRoot), { recursive: true });
    await writeFile(
      join(external.SUBAGENTS_ASYNC_DIR, failedRoot, "status.json"),
      JSON.stringify({
        runId: failedRunId,
        sessionId: parentSessionId,
        mode: "parallel",
        state: "failed",
        startedAt: 3_000,
        endedAt: 8_000,
        steps: [
          {
            agent: "reviewer",
            status: "failed",
            model: "provider/reviewer",
            startedAt: 3_500,
            endedAt: 7_500,
            durationMs: 4_000,
            error: "focused fixture failure",
          },
        ],
      }),
      "utf8",
    );
    await mkdir(join(external.SUBAGENTS_ASYNC_DIR, processFailedRoot), { recursive: true });
    await writeFile(
      join(external.SUBAGENTS_ASYNC_DIR, processFailedRoot, "status.json"),
      JSON.stringify({
        runId: processFailedRunId,
        sessionId: parentSessionId,
        state: "complete",
        steps: [{ agent: "worker", status: "complete" }],
      }),
      "utf8",
    );
    await mkdir(external.SUBAGENTS_RESULTS_DIR, { recursive: true });
    await writeFile(
      join(external.SUBAGENTS_RESULTS_DIR, `${processFailedRoot}.json`),
      JSON.stringify({
        runId: processFailedRunId,
        sessionId: parentSessionId,
        success: false,
        results: [{ agent: "worker", exitCode: 1 }],
      }),
      "utf8",
    );

    await mkdir(join(external.SUBAGENTS_ASYNC_DIR, malformedRoot), { recursive: true });
    await writeFile(
      join(external.SUBAGENTS_ASYNC_DIR, malformedRoot, "status.json"),
      JSON.stringify({ runId: "malformed", state: "mystery" }),
      "utf8",
    );

    const beforeResultRuns = await external.listExternalSubagentFleetRuns();
    assert(
      "terminal status is visible before its delayed result artifact",
      beforeResultRuns.find((run) => run.runId === failedRunId)?.children[0]?.sessionId ===
        undefined,
    );
    await mkdir(external.SUBAGENTS_RESULTS_DIR, { recursive: true });
    await writeFile(
      join(external.SUBAGENTS_RESULTS_DIR, `${failedRoot}.json`),
      JSON.stringify({
        runId: failedRunId,
        sessionId: parentSessionId,
        success: false,
        results: [
          { agent: "reviewer", error: "focused fixture failure", sessionFile: failedChildPath },
        ],
      }),
      "utf8",
    );

    const allRuns = await external.listExternalSubagentFleetRuns();
    const active = allRuns.find((run) => run.runId === activeRunId);
    const failed = allRuns.find((run) => run.runId === failedRunId);
    const processFailed = allRuns.find((run) => run.runId === processFailedRunId);
    assert(
      "fleet preserves full stable run identities beyond 500 characters",
      active?.parentSessionId === parentSessionId &&
        active.state === "running" &&
        active.runId === activeRunId &&
        failed?.runId === failedRunId &&
        active.runId !== failed.runId &&
        new Set(allRuns.map((run) => run.runId)).size === allRuns.length,
      JSON.stringify(allRuns.map((run) => run.runId)),
    );
    assert(
      "fleet exposes child session, model, and stable run-scoped child id",
      active?.children[0]?.sessionId === activeChildSessionId &&
        active.children[0].model === "provider/model" &&
        active.children[0].childId === `${activeRunId}:0`,
      JSON.stringify(active?.children[0]),
    );
    assert(
      "fleet retains terminal status, duration, error, and result-file child session",
      failed?.state === "failed" &&
        failed.durationMs === 5_000 &&
        failed.error === "focused fixture failure" &&
        failed.children[0]?.durationMs === 4_000 &&
        failed.children[0].sessionId === failedChildSessionId,
      JSON.stringify(failed),
    );
    assert(
      "non-zero pi-subagent exit code projects completed status as failed",
      processFailed?.state === "failed" &&
        processFailed.children[0]?.state === "failed" &&
        processFailed.error === "Subagent exited with code 1" &&
        processFailed.children[0]?.error === "Subagent exited with code 1",
      JSON.stringify(processFailed),
    );
    const activeStatusPath = join(external.SUBAGENTS_ASYNC_DIR, activeRoot, "status.json");
    const activeStatus = JSON.parse(await readFile(activeStatusPath, "utf8")) as {
      lastActivityAt: number;
    };
    activeStatus.lastActivityAt = 3_000;
    await writeFile(activeStatusPath, JSON.stringify(activeStatus), "utf8");
    const forcedRuns = await external.listExternalSubagentFleetRuns(true);
    assert(
      "forced Fleet reload reads updated lifecycle artifacts",
      forcedRuns.find((run) => run.runId === activeRunId)?.lastActivityAt === 3_000,
    );

    assert(
      "active runs sort before terminal runs",
      allRuns.findIndex((run) => run.runId === activeRunId) <
        allRuns.findIndex((run) => run.runId === failedRunId),
    );
    assert(
      "malformed lifecycle artifacts are skipped",
      !allRuns.some((run) => run.runId === "malformed"),
    );

    const grouped = groupSubagentFleetRuns([active!, failed!]);
    assert(
      "client hierarchy groups runs only by stable parentSessionId",
      grouped.length === 1 &&
        grouped[0]?.parentSessionId === parentSessionId &&
        grouped[0].runs.map((run) => run.runId).join(",") === `${activeRunId},${failedRunId}`,
      JSON.stringify(grouped),
    );
    assert(
      "duration formatter derives live and terminal durations",
      formatSubagentDuration(undefined, 1_000, undefined, 66_000) === "1m 5s" &&
        formatSubagentDuration(undefined, 1_000, 3_000) === "2s",
    );
    const oversizedRunId = "r".repeat(160);
    assert(
      "Clean filters only selected Fleet rows and hierarchy defaults expand active work",
      filterCleanedSubagentFleetRuns(allRuns, new Set([failedRunId, processFailedRunId])).every(
        (run) => run.runId !== failedRunId && run.runId !== processFailedRunId,
      ) &&
        shouldExpandSubagentFleetRuns([active!]) &&
        !shouldExpandSubagentFleetRuns([failed!]) &&
        shouldExpandSubagentFleetRun(active!) &&
        !shouldExpandSubagentFleetRun(failed!),
    );
    assert(
      "child navigation waits for normal session discovery before it is enabled",
      !isSubagentFleetChildSessionDiscovered(activeChildSessionId, new Set()) &&
        isSubagentFleetChildSessionDiscovered(
          activeChildSessionId,
          new Set([activeChildSessionId]),
        ),
    );
    assert(
      "fleet run ids are safely truncated for narrow cards",
      truncateSubagentFleetRunId(oversizedRunId) === `${"r".repeat(79)}…` &&
        truncateSubagentFleetRunId("short-run") === "short-run",
    );

    const navigationGuard = createSubagentFleetNavigationGuard();
    const staleNavigation = navigationGuard.start();
    const concurrentNavigation = navigationGuard.start();
    navigationGuard.invalidate();
    const reopenedNavigationGuard = createSubagentFleetNavigationGuard();
    const reopenedNavigation = reopenedNavigationGuard.start();
    assert(
      "closing the fleet invalidates in-flight child navigation before a later reopen",
      staleNavigation !== undefined &&
        concurrentNavigation === undefined &&
        !navigationGuard.isCurrent(staleNavigation) &&
        reopenedNavigation !== undefined &&
        reopenedNavigationGuard.isCurrent(reopenedNavigation),
    );

    await Promise.all([
      rm(join(external.SUBAGENTS_ASYNC_DIR, activeRoot), { recursive: true, force: true }),
      rm(join(external.SUBAGENTS_ASYNC_DIR, failedRoot), { recursive: true, force: true }),
      rm(join(external.SUBAGENTS_ASYNC_DIR, processFailedRoot), { recursive: true, force: true }),
    ]);
    await external.listExternalSubagentFleetRuns();
    assert(
      "fleet cache prunes deleted lifecycle roots",
      !external._hasExternalSubagentFleetRunCacheEntryForTests(activeRoot) &&
        !external._hasExternalSubagentFleetRunCacheEntryForTests(failedRoot),
    );
  } finally {
    await Promise.all(cleanupPaths.map((path) => rm(path, { recursive: true, force: true })));
  }

  if (failures > 0) process.exit(1);
  console.log("PASS test-subagent-fleet");
}

await main();
