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
    listExternalSupervisorRequests: () => Promise<
      {
        requestId: string;
        parentSessionId: string;
        runId: string;
        agent: string;
        childIndex: number;
        decision: string;
        status: string;
        replyMessage?: string;
      }[]
    >;
    replyExternalSupervisorRequest: (
      requestId: string,
      message: string,
      decision: "approved" | "rejected" | "no-decision",
    ) => Promise<{ accepted: boolean; decision?: string }>;
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
    ) => Promise<{
      sessionId: string;
      session: {
        messages: readonly unknown[];
        sessionManager: { appendMessage: (message: unknown) => void };
      };
    }>;
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
    // Empty sessions intentionally have no JSONL. Persist a minimal fixture so
    // resumeSession exercises the real cold-parent registry path without an LLM.
    parent.session.sessionManager.appendMessage({
      role: "assistant",
      content: [{ type: "text", text: "supervisor replay fixture", id: "fixture" }],
      api: "messages",
      provider: "anthropic",
      model: "test-fixture",
      usage: {
        input: 0,
        output: 0,
        cacheRead: 0,
        cacheWrite: 0,
        totalTokens: 0,
        cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
      },
      stopReason: "stop",
      timestamp: Date.now(),
    });
    // Make the parent genuinely cold before the browser action. The resume
    // path, not a direct helper call, must restore the durable reply card.
    await registry.disposeSession(parent.sessionId);
    await new Promise((resolve) => setTimeout(resolve, 1_600));

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
        message: "Should this browser approval survive cold resume?",
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
    await rm(join(replayChannel, "requests", `${replayId}.json`));
    const fleetAfterNativeCleanup = await external.listExternalSupervisorRequests();

    // A reused native id in another immutable tuple must not inherit the
    // old browser classification or reply text.
    const reusedRunId = `supervisor-reused-${randomUUID()}`;
    const reusedChannel = join(
      external.SUBAGENTS_SUPERVISOR_CHANNEL_DIR,
      `${reusedRunId}-other-worker-1`,
    );
    await mkdir(join(reusedChannel, "requests"), { recursive: true });
    await writeFile(
      join(reusedChannel, "requests", `${replayId}.json`),
      JSON.stringify({
        type: "subagent.supervisor.request",
        id: replayId,
        createdAt: Date.now(),
        expiresAt: Date.now() + 60_000,
        reason: "need_decision",
        message: "A new request reused the native id.",
        expectsReply: true,
        orchestratorSessionId: parent.sessionId,
        runId: reusedRunId,
        agent: "other-worker",
        childIndex: 1,
      }),
      "utf8",
    );
    const fleetWithCollision = await external.listExternalSupervisorRequests();
    const oldFleetRequest = fleetWithCollision.find(
      (request) => request.runId === replayRunId && request.requestId === replayId,
    );
    const reusedFleetRequest = fleetWithCollision.find(
      (request) => request.runId === reusedRunId && request.requestId === replayId,
    );
    assert(
      "reused supervisor request ids do not inherit a different tuple's browser decision",
      oldFleetRequest?.decision === "approved" &&
        oldFleetRequest.replyMessage === browserReply &&
        reusedFleetRequest?.decision === "no-decision" &&
        reusedFleetRequest.replyMessage === undefined,
      JSON.stringify(fleetWithCollision),
    );

    const hasBrowserCard = (
      messages: readonly unknown[],
      request: {
        requestId: string;
        parentSessionId: string;
        runId: string;
        agent: string;
        childIndex: number;
      },
      replyMessage: string,
      decision: "approved" | "rejected",
    ): boolean =>
      messages.some((candidate) => {
        const value = candidate as {
          role?: unknown;
          customType?: unknown;
          content?: unknown;
          details?: Record<string, unknown>;
        };
        return (
          value.role === "custom" &&
          value.customType === "subagent_supervisor_reply" &&
          value.content === replyMessage &&
          value.details?.source === "pi-forge" &&
          value.details.decision === decision &&
          value.details.requestId === request.requestId &&
          value.details.parentSessionId === request.parentSessionId &&
          value.details.runId === request.runId &&
          value.details.agent === request.agent &&
          value.details.childIndex === request.childIndex
        );
      });
    const resumed = await registry.resumeSession(parent.sessionId, project.id, fixtureDir);
    assert(
      "cold parent resume restores the native-cleaned browser approval as an authoritative Chat and Fleet result",
      accepted.accepted &&
        accepted.decision === "approved" &&
        fleetAfterNativeCleanup.some(
          (request) =>
            request.runId === replayRunId &&
            request.requestId === replayId &&
            request.status === "answered" &&
            request.decision === "approved" &&
            request.replyMessage === browserReply,
        ) &&
        hasBrowserCard(
          resumed.session.messages,
          {
            requestId: replayId,
            parentSessionId: parent.sessionId,
            runId: replayRunId,
            agent: "worker",
            childIndex: 0,
          },
          browserReply,
          "approved",
        ),
      JSON.stringify({ fleetAfterNativeCleanup, messages: resumed.session.messages }),
    );

    const rejectedParent = await registry.createSession(project.id, fixtureDir);
    rejectedParent.session.sessionManager.appendMessage({
      role: "assistant",
      content: [{ type: "text", text: "supervisor rejection fixture", id: "fixture" }],
      api: "messages",
      provider: "anthropic",
      model: "test-fixture",
      usage: {
        input: 0,
        output: 0,
        cacheRead: 0,
        cacheWrite: 0,
        totalTokens: 0,
        cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
      },
      stopReason: "stop",
      timestamp: Date.now(),
    });
    // As with approval, reject after disposal so only durable history can
    // restore the browser reply card during the genuine cold resume path.
    await registry.disposeSession(rejectedParent.sessionId);
    await new Promise((resolve) => setTimeout(resolve, 1_600));

    const rejectId = randomUUID();
    const rejectRunId = `supervisor-reject-${randomUUID()}`;
    const rejectChannel = join(
      external.SUBAGENTS_SUPERVISOR_CHANNEL_DIR,
      `${rejectRunId}-worker-0`,
    );
    await mkdir(join(rejectChannel, "requests"), { recursive: true });
    await writeFile(
      join(rejectChannel, "requests", `${rejectId}.json`),
      JSON.stringify({
        type: "subagent.supervisor.request",
        id: rejectId,
        createdAt: Date.now(),
        expiresAt: Date.now() + 60_000,
        reason: "need_decision",
        message: "Should this browser rejection survive cold resume?",
        expectsReply: true,
        orchestratorSessionId: rejectedParent.sessionId,
        runId: rejectRunId,
        agent: "worker",
        childIndex: 0,
      }),
      "utf8",
    );
    const rejectReply = "Reject this exact browser decision.";
    const rejected = await external.replyExternalSupervisorRequest(
      rejectId,
      rejectReply,
      "rejected",
    );
    await rm(join(rejectChannel, "requests", `${rejectId}.json`));
    const fleetAfterRejectNativeCleanup = await external.listExternalSupervisorRequests();
    const rejectedResumed = await registry.resumeSession(
      rejectedParent.sessionId,
      project.id,
      fixtureDir,
    );
    assert(
      "cold parent resume restores the native-cleaned browser rejection as an authoritative Chat and Fleet result",
      rejected.accepted &&
        rejected.decision === "rejected" &&
        fleetAfterRejectNativeCleanup.some(
          (request) =>
            request.runId === rejectRunId &&
            request.requestId === rejectId &&
            request.status === "answered" &&
            request.decision === "rejected" &&
            request.replyMessage === rejectReply,
        ) &&
        hasBrowserCard(
          rejectedResumed.session.messages,
          {
            requestId: rejectId,
            parentSessionId: rejectedParent.sessionId,
            runId: rejectRunId,
            agent: "worker",
            childIndex: 0,
          },
          rejectReply,
          "rejected",
        ),
      JSON.stringify({
        fleetAfterRejectNativeCleanup,
        messages: rejectedResumed.session.messages,
      }),
    );
    await registry.disposeSession(parent.sessionId);
    await registry.disposeSession(rejectedParent.sessionId);
    await rm(replayChannel, { recursive: true, force: true });
    await rm(reusedChannel, { recursive: true, force: true });
    await rm(rejectChannel, { recursive: true, force: true });
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
