import { randomUUID } from "node:crypto";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const repoRoot = resolve(fileURLToPath(new URL("..", import.meta.url)));
let failures = 0;

function assert(label: string, ok: boolean, detail?: string): void {
  if (ok) console.log(`PASS ${label}`);
  else {
    failures += 1;
    console.error(`FAIL ${label}${detail === undefined ? "" : `: ${detail}`}`);
  }
}

async function main(): Promise<void> {
  const fixtureDir = await mkdtemp(join(tmpdir(), "pi-forge-supervisor-test-"));
  process.env.NODE_ENV = "test";
  process.env.WORKSPACE_PATH = fixtureDir;
  process.env.PI_CONFIG_DIR = join(fixtureDir, "config");
  process.env.FORGE_DATA_DIR = join(fixtureDir, "data");

  const external = (await import(
    resolve(repoRoot, "packages/server/dist/subagents-external.js")
  )) as {
    SUBAGENTS_SUPERVISOR_CHANNEL_DIR: string;
    MAX_SUPERVISOR_FILES_PER_REFRESH: number;
    listExternalSupervisorRequests: () => Promise<{ requestId: string }[]>;
    replyExternalSupervisorRequest: (
      requestId: string,
      message: string,
      decision: "approved" | "rejected" | "no-decision",
    ) => Promise<{ accepted: boolean; decision?: string }>;
    replayForgeSupervisorRepliesForSession: (sessionId: string) => Promise<void>;
  };
  const projects = (await import(resolve(repoRoot, "packages/server/dist/project-manager.js"))) as {
    createProject: (name: string, path: string) => Promise<{ id: string }>;
  };
  const registry = (await import(
    resolve(repoRoot, "packages/server/dist/session-registry.js")
  )) as {
    createSession: (
      projectId: string,
      workspacePath: string,
    ) => Promise<{ sessionId: string; session: { messages: readonly unknown[] } }>;
    disposeSession: (sessionId: string) => Promise<void>;
    resumeSession: (
      sessionId: string,
      projectId: string,
      workspacePath: string,
    ) => Promise<{ session: { messages: readonly unknown[] } }>;
  };
  const runId = `supervisor-${randomUUID()}`;
  const requestId = randomUUID();
  const validChannel = join(external.SUBAGENTS_SUPERVISOR_CHANNEL_DIR, `${runId}-worker-0`);
  const noisyChannel = join(
    external.SUBAGENTS_SUPERVISOR_CHANNEL_DIR,
    `unrelated-${randomUUID()}-worker-0`,
  );

  try {
    await Promise.all([
      mkdir(join(validChannel, "requests"), { recursive: true }),
      mkdir(join(noisyChannel, "requests"), { recursive: true }),
    ]);
    await writeFile(
      join(validChannel, "requests", `${requestId}.json`),
      JSON.stringify({
        type: "subagent.supervisor.request",
        id: requestId,
        createdAt: Date.now(),
        expiresAt: Date.now() + 60_000,
        reason: "need_decision",
        message: "Keep accepting valid requests.",
        expectsReply: true,
        orchestratorSessionId: randomUUID(),
        runId,
        agent: "worker",
        childIndex: 0,
      }),
      "utf8",
    );
    await Promise.all(
      Array.from({ length: external.MAX_SUPERVISOR_FILES_PER_REFRESH * 2 }, (_, index) =>
        writeFile(join(noisyChannel, "requests", `malformed-${index}.json`), "{ malformed", "utf8"),
      ),
    );
    await Promise.all(
      Array.from({ length: external.MAX_SUPERVISOR_FILES_PER_REFRESH * 2 }, (_, index) =>
        writeFile(join(noisyChannel, "requests", `unrelated-${index}.txt`), "unrelated", "utf8"),
      ),
    );

    let parseCalls = 0;
    const originalParse = JSON.parse;
    JSON.parse = ((text: string, reviver?: (key: string, value: unknown) => unknown) => {
      parseCalls += 1;
      return originalParse(text, reviver);
    }) as typeof JSON.parse;
    let requests: { requestId: string }[] = [];
    try {
      requests = await external.listExternalSupervisorRequests();
    } finally {
      JSON.parse = originalParse;
    }
    assert(
      "supervisor refresh caps malformed artifact parsing while retaining a valid request",
      parseCalls <= external.MAX_SUPERVISOR_FILES_PER_REFRESH &&
        requests.some((request) => request.requestId === requestId),
      JSON.stringify({ parseCalls, requests }),
    );

    const project = await projects.createProject("supervisor-replay", fixtureDir);
    const parent = await registry.createSession(project.id, fixtureDir);
    const replayId = randomUUID();
    const replayRunId = `supervisor-replay-${randomUUID()}`;
    const replayChannel = join(
      external.SUBAGENTS_SUPERVISOR_CHANNEL_DIR,
      `${replayRunId}-worker-0`,
    );
    await mkdir(join(replayChannel, "requests"), { recursive: true });
    await writeFile(
      join(replayChannel, "requests", `${replayId}.json`),
      JSON.stringify({
        type: "subagent.supervisor.request",
        id: replayId,
        createdAt: Date.now(),
        expiresAt: Date.now() + 60_000,
        reason: "need_decision",
        message: "Should this browser approval survive reload?",
        expectsReply: true,
        orchestratorSessionId: parent.sessionId,
        runId: replayRunId,
        agent: "worker",
        childIndex: 0,
      }),
      "utf8",
    );
    const browserReply = "Approve this exact browser decision.";
    const accepted = await external.replyExternalSupervisorRequest(
      replayId,
      browserReply,
      "approved",
    );
    const hasBrowserCard = (
      messages: readonly unknown[],
      requestId: string,
      message: string,
      decision: "approved" | "rejected",
    ): boolean =>
      messages.some((candidate) => {
        const value = candidate as {
          role?: unknown;
          customType?: unknown;
          content?: unknown;
          details?: { decision?: unknown; requestId?: unknown; source?: unknown };
        };
        return (
          value.role === "custom" &&
          value.customType === "subagent_supervisor_reply" &&
          value.content === message &&
          value.details?.source === "pi-forge" &&
          value.details.decision === decision &&
          value.details.requestId === requestId
        );
      });
    assert(
      "browser approval emits an exact classified direct Chat event",
      accepted.accepted &&
        accepted.decision === "approved" &&
        hasBrowserCard(parent.session.messages, replayId, browserReply, "approved"),
      JSON.stringify(parent.session.messages),
    );
    const rejectId = randomUUID();
    const rejectReply = "Reject this exact browser decision.";
    await writeFile(
      join(replayChannel, "requests", `${rejectId}.json`),
      JSON.stringify({
        type: "subagent.supervisor.request",
        id: rejectId,
        createdAt: Date.now(),
        expiresAt: Date.now() + 60_000,
        reason: "need_decision",
        message: "Should this browser rejection survive reload?",
        expectsReply: true,
        orchestratorSessionId: parent.sessionId,
        runId: replayRunId,
        agent: "worker",
        childIndex: 0,
      }),
      "utf8",
    );
    const rejected = await external.replyExternalSupervisorRequest(
      rejectId,
      rejectReply,
      "rejected",
    );
    assert(
      "browser rejection emits an exact classified direct Chat event",
      rejected.accepted &&
        rejected.decision === "rejected" &&
        hasBrowserCard(parent.session.messages, rejectId, rejectReply, "rejected"),
      JSON.stringify(parent.session.messages),
    );
    await rm(join(replayChannel, "requests", `${replayId}.json`));
    await external.listExternalSupervisorRequests();
    const liveMessages = parent.session.messages as unknown[];
    liveMessages.splice(0, liveMessages.length);
    await external.replayForgeSupervisorRepliesForSession(parent.sessionId);
    assert(
      "browser approval survives native cleanup and replay as one exact classified Chat event",
      hasBrowserCard(parent.session.messages, replayId, browserReply, "approved"),
      JSON.stringify(parent.session.messages),
    );
    await registry.disposeSession(parent.sessionId);
  } finally {
    await Promise.all([
      rm(validChannel, { recursive: true, force: true }),
      rm(noisyChannel, { recursive: true, force: true }),
      rm(fixtureDir, { recursive: true, force: true }),
    ]);
  }

  if (failures > 0) process.exit(1);
  console.log("PASS test-subagent-supervisor");
}

await main();
