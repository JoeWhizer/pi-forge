import { mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { randomUUID } from "node:crypto";
import {
  formatSubagentDuration,
  groupSubagentFleetRuns,
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
    listExternalSubagentFleetRuns: () => Promise<SubagentFleetRun[]>;
  };

  const activeRoot = `fleet-active-${randomUUID()}`;
  const failedRoot = `fleet-failed-${randomUUID()}`;
  const malformedRoot = `fleet-malformed-${randomUUID()}`;
  const activeRunId = `stable-run-${randomUUID()}`;
  const failedRunId = `stable-run-${randomUUID()}`;
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
    join(external.SUBAGENTS_RESULTS_DIR, `${failedRoot}.json`),
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
    assert(
      "fleet discovers active run with stable parent and run ids",
      active?.parentSessionId === parentSessionId && active.state === "running",
      JSON.stringify(active),
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
  } finally {
    await Promise.all(cleanupPaths.map((path) => rm(path, { recursive: true, force: true })));
  }

  if (failures > 0) process.exit(1);
  console.log("PASS test-subagent-fleet");
}

await main();
