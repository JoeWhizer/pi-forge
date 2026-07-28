/**
 * Integration test for pi-subagents child-session discovery in the
 * server's session-registry.
 *
 * pi-subagents writes child sessions to
 * `<sessionDir>/<parentSessionId>/<runId>/<childId>.jsonl`. The
 * registry has to:
 *   1. Surface those children via `discoverSessionsOnDisk` with
 *      `parentSessionId` + `runId` set (so the sidebar can render
 *      a chevron dropdown grouping children under their parent).
 *   2. Resolve a child by its UUID via `findSessionLocation` (so
 *      cross-project resume-by-id works).
 *   3. Resume a child as a normal LiveSession via `resumeSession`
 *      (so clicking a SubagentResultCard's "Open" button hydrates the
 *      child's chat view).
 *   4. Continue to surface top-level (non-child) sessions alongside
 *      children — no regression on the existing happy path.
 *
 * The test fakes a child JSONL by hand with a minimal SDK-shaped
 * header. We don't need the pi-subagents plugin actually installed;
 * the registry treats any JSONL nested one level deeper than the
 * project session dir as a child.
 */
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { randomUUID } from "node:crypto";

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
const repoRoot = resolve(__dirname, "..");

let failures = 0;
function assert(label: string, ok: boolean, detail?: string): void {
  if (ok) console.log(`  PASS  ${label}`);
  else {
    failures += 1;
    console.log(`  FAIL  ${label}${detail ? ` — ${detail}` : ""}`);
  }
}

async function setupEnv(): Promise<{
  workspacePath: string;
  configDir: string;
  dataDir: string;
  sessionDir: string;
}> {
  const workspacePath = await mkdtemp(join(tmpdir(), "pi-forge-ws-"));
  const configDir = await mkdtemp(join(tmpdir(), "pi-forge-cfg-"));
  const dataDir = await mkdtemp(join(tmpdir(), "pi-forge-data-"));
  const sessionDir = join(workspacePath, ".pi", "sessions");
  process.env.WORKSPACE_PATH = workspacePath;
  process.env.PI_CONFIG_DIR = configDir;
  process.env.FORGE_DATA_DIR = dataDir;
  process.env.SESSION_DIR = sessionDir;
  process.env.NODE_ENV = "test";
  delete process.env.UI_PASSWORD;
  delete process.env.JWT_SECRET;
  delete process.env.API_KEY;
  return { workspacePath, configDir, dataDir, sessionDir };
}

/** Write a minimal SDK-shaped session JSONL header file at `path`. */
async function writeChildSessionFile(path: string, sessionId: string, cwd: string): Promise<void> {
  await mkdir(dirname(path), { recursive: true });
  const header = {
    type: "session",
    version: 1,
    id: sessionId,
    timestamp: new Date().toISOString(),
    cwd,
  };
  await writeFile(path, JSON.stringify(header) + "\n", "utf8");
}

interface TestLive {
  session: {
    sessionId: string;
    sessionFile?: string;
    messages?: unknown[];
    sessionManager: { appendMessage: (msg: unknown) => string };
  };
  sessionId: string;
  clients: Set<{ send: (event: unknown) => void }>;
}
interface TestDiscovered {
  sessionId: string;
  path: string;
  parentSessionId?: string;
  runId?: string;
}
interface TestUnifiedSession {
  sessionId: string;
  parentSessionId?: string;
  runId?: string;
  isLive?: boolean;
  isExternalLive?: boolean;
  externalState?: "queued" | "running" | "complete" | "failed" | "paused" | "stopped";
  backgroundSubagentRuns?: {
    runId: string;
    state: "queued" | "running" | "complete" | "failed" | "paused" | "stopped";
  }[];
}
interface TestRegistry {
  createSession: (projectId: string, workspacePath: string) => Promise<TestLive>;
  disposeSession: (id: string) => Promise<boolean>;
  disposeAllSessions: () => Promise<void>;
  resumeSession: (id: string, projectId: string, workspacePath: string) => Promise<TestLive>;
  resumeSessionById: (id: string) => Promise<TestLive>;
  discoverSessionsOnDisk: (projectId: string, workspacePath: string) => Promise<TestDiscovered[]>;
  refreshProjectSessionIndex: (
    projectId: string,
    workspacePath: string,
  ) => Promise<TestDiscovered[]>;
  listSessionsForProject: (
    projectId: string,
    workspacePath: string,
  ) => Promise<TestUnifiedSession[]>;
  findSessionLocation: (
    id: string,
  ) => Promise<{ projectId: string; workspacePath: string } | undefined>;
  deleteColdSession: (id: string) => Promise<"deleted" | "live" | "not_found">;
  getSession: (id: string) => TestLive | undefined;
}
interface TestProjectManager {
  createProject: (name: string, path: string) => Promise<{ id: string; path: string }>;
}
interface TestOrchestrationStore {
  enableSupervisor: (sessionId: string) => Promise<unknown>;
  registerWorker: (opts: { supervisorId: string; workerId: string }) => Promise<void>;
}

function appendFixtureMessage(live: TestLive, text: string): void {
  live.session.sessionManager.appendMessage({
    role: "assistant",
    content: [{ type: "text", text, id: "stub-1" }],
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
}

async function main(): Promise<void> {
  const { workspacePath, sessionDir } = await setupEnv();
  console.log(`[test-subagent-discovery] WORKSPACE_PATH=${workspacePath}`);
  console.log(`[test-subagent-discovery] SESSION_DIR=${sessionDir}`);

  const registry = (await import(
    resolve(repoRoot, "packages/server/dist/session-registry.js")
  )) as unknown as TestRegistry;
  const pm = (await import(
    resolve(repoRoot, "packages/server/dist/project-manager.js")
  )) as unknown as TestProjectManager;
  const orchestrationStore = (await import(
    resolve(repoRoot, "packages/server/dist/orchestration/store.js")
  )) as unknown as TestOrchestrationStore;
  const subagentsExternal = (await import(
    resolve(repoRoot, "packages/server/dist/subagents-external.js")
  )) as {
    SUBAGENTS_ASYNC_DIR: string;
    SUBAGENTS_RESULTS_DIR: string;
    deliverExternalSubagentCompletionForRun: (runId: string) => Promise<void>;
    deliverExternalSubagentSessionListChange: (runId: string) => Promise<void>;
  };

  // Register a project below the configured workspace root, matching the
  // container path relationship exercised by Production.
  const projectPath = join(workspacePath, "test-subagent-project");
  await mkdir(projectPath, { recursive: true });
  const project = await pm.createProject("test-subagent-project", projectPath);

  try {
    // 1. Parent session — created via the registry like any normal session.
    const parent = await registry.createSession(project.id, project.path);
    assert(
      "createSession returns a parent session with a sessionId",
      typeof parent.sessionId === "string" && parent.sessionId.length > 0,
    );
    // The SDK only flushes JSONL once a message is appended (matches
    // the live-test pattern in tests/test-session.ts). Inject a
    // minimal assistant message so the parent's JSONL header lands on
    // disk and `discoverSessionsOnDisk` can see it.
    appendFixtureMessage(parent, "test fixture");
    const parentListChanges: Array<{ type?: unknown; reason?: unknown }> = [];
    parent.clients.add({
      send: (event) => parentListChanges.push(event as { type?: unknown; reason?: unknown }),
    });

    // 1b. The plugin can create a child before the parent JSONL is visible to
    // disk discovery. The live registry supplies the parent's exact session
    // file identity, so no timestamp/name inference is needed to nest it.
    const delayedParent = await registry.createSession(project.id, project.path);
    const delayedParentListChanges: Array<{ type?: unknown; reason?: unknown }> = [];
    delayedParent.clients.add({
      send: (event) => delayedParentListChanges.push(event as { type?: unknown; reason?: unknown }),
    });
    const delayedParentFile = delayedParent.session.sessionFile;
    const delayedParentBase =
      typeof delayedParentFile === "string" && delayedParentFile.endsWith(".jsonl")
        ? basename(delayedParentFile, ".jsonl")
        : undefined;
    const delayedChild = randomUUID();
    if (delayedParentBase !== undefined) {
      await writeChildSessionFile(
        join(sessionDir, project.id, delayedParentBase, "foreground-run", `${delayedChild}.jsonl`),
        delayedChild,
        project.path,
      );
    }
    const delayedDiscovery = await registry.discoverSessionsOnDisk(project.id, project.path);
    const delayedChildEntry = delayedDiscovery.find((s) => s.sessionId === delayedChild);
    assert(
      "foreground child remains nested when discovered before parent JSONL",
      delayedParentBase !== undefined &&
        delayedChildEntry?.parentSessionId === delayedParent.sessionId,
      `parentSessionId=${delayedChildEntry?.parentSessionId} expected=${delayedParent.sessionId}`,
    );

    // The async launch receipt/status exists before pi-subagents writes a
    // discoverable child JSONL. The parent must expose this stable run id so
    // the sidebar can render activity immediately, including after reconnect.
    const preDiscoveryRunId = `pre-discovery-${randomUUID().slice(0, 8)}`;
    await mkdir(join(subagentsExternal.SUBAGENTS_ASYNC_DIR, preDiscoveryRunId), {
      recursive: true,
    });
    await writeFile(
      join(subagentsExternal.SUBAGENTS_ASYNC_DIR, preDiscoveryRunId, "status.json"),
      JSON.stringify({
        runId: preDiscoveryRunId,
        sessionId: delayedParent.sessionId,
        state: "running",
      }),
      "utf8",
    );
    await subagentsExternal.deliverExternalSubagentSessionListChange(preDiscoveryRunId);
    await subagentsExternal.deliverExternalSubagentSessionListChange(preDiscoveryRunId);
    assert(
      "repeated running status emits one parent list update",
      delayedParentListChanges.filter(
        (event) =>
          event.type === "session_list_changed" && event.reason === "subagent_async_running",
      ).length === 1,
      `events=${JSON.stringify(delayedParentListChanges)}`,
    );
    const preDiscoveryActiveList = await registry.listSessionsForProject(project.id, project.path);
    const preDiscoveryParent = preDiscoveryActiveList.find(
      (s) => s.sessionId === delayedParent.sessionId,
    );
    assert(
      "parent exposes running background run before child discovery",
      preDiscoveryParent?.backgroundSubagentRuns?.some(
        (run) => run.runId === preDiscoveryRunId && run.state === "running",
      ) === true,
      `row=${JSON.stringify(preDiscoveryParent)}`,
    );
    await writeFile(
      join(subagentsExternal.SUBAGENTS_ASYNC_DIR, preDiscoveryRunId, "status.json"),
      JSON.stringify({
        runId: preDiscoveryRunId,
        sessionId: delayedParent.sessionId,
        state: "paused",
      }),
      "utf8",
    );
    const preDiscoveryPausedList = await registry.listSessionsForProject(project.id, project.path);
    assert(
      "paused status confirms lifecycle on the parent before child discovery",
      preDiscoveryPausedList
        .find((s) => s.sessionId === delayedParent.sessionId)
        ?.backgroundSubagentRuns?.some(
          (run) => run.runId === preDiscoveryRunId && run.state === "paused",
        ) === true,
      `row=${JSON.stringify(preDiscoveryPausedList.find((s) => s.sessionId === delayedParent.sessionId))}`,
    );
    for (const terminalState of ["complete", "failed", "stopped"] as const) {
      await writeFile(
        join(subagentsExternal.SUBAGENTS_ASYNC_DIR, preDiscoveryRunId, "status.json"),
        JSON.stringify({
          runId: preDiscoveryRunId,
          sessionId: delayedParent.sessionId,
          state: terminalState,
        }),
        "utf8",
      );
      const preDiscoveryTerminalList = await registry.listSessionsForProject(
        project.id,
        project.path,
      );
      assert(
        `${terminalState} status remains in the parent lifecycle projection before child discovery`,
        preDiscoveryTerminalList
          .find((s) => s.sessionId === delayedParent.sessionId)
          ?.backgroundSubagentRuns?.some(
            (run) => run.runId === preDiscoveryRunId && run.state === terminalState,
          ) === true,
      );
    }

    // 2. Fake a pi-subagents child JSONL nested under the parent's id.
    //    Layout: <sessionDir>/<projectId>/<parentId>/<runId>/<childId>.jsonl
    const runId = "run-" + randomUUID().slice(0, 8);
    const childA = randomUUID();
    const childB = randomUUID();
    const projectSessionDir = join(sessionDir, project.id);
    const childAPath = join(projectSessionDir, parent.sessionId, runId, `${childA}.jsonl`);
    const childBPath = join(projectSessionDir, parent.sessionId, runId, `${childB}.jsonl`);
    await writeChildSessionFile(childAPath, childA, project.path);
    await writeChildSessionFile(childBPath, childB, project.path);

    // A stopped async status may be observed before its parent JSONL is
    // discoverable (for example after cancellation during a server restart).
    // Its exact sessionId must preserve the child link until the parent row arrives.
    const stoppedBeforeParentId = randomUUID();
    const stoppedBeforeParentChildId = randomUUID();
    const stoppedBeforeParentRunId = `stopped-${randomUUID().slice(0, 8)}`;
    const stoppedBeforeParentChildPath = join(
      projectSessionDir,
      stoppedBeforeParentId,
      stoppedBeforeParentRunId,
      "run-0",
      `${stoppedBeforeParentChildId}.jsonl`,
    );
    await writeChildSessionFile(
      stoppedBeforeParentChildPath,
      stoppedBeforeParentChildId,
      project.path,
    );
    await mkdir(join(subagentsExternal.SUBAGENTS_ASYNC_DIR, stoppedBeforeParentRunId), {
      recursive: true,
    });
    await writeFile(
      join(subagentsExternal.SUBAGENTS_ASYNC_DIR, stoppedBeforeParentRunId, "status.json"),
      JSON.stringify({
        runId: stoppedBeforeParentRunId,
        sessionId: stoppedBeforeParentId,
        state: "stopped",
        sessionFile: stoppedBeforeParentChildPath,
      }),
      "utf8",
    );
    const stoppedBeforeParentList = await registry.listSessionsForProject(project.id, project.path);
    const stoppedBeforeParentChild = stoppedBeforeParentList.find(
      (s) => s.sessionId === stoppedBeforeParentChildId,
    );
    assert(
      "stopped status clears background activity and retains the parent before discovery",
      stoppedBeforeParentChild?.parentSessionId === stoppedBeforeParentId &&
        stoppedBeforeParentChild.isExternalLive === false &&
        stoppedBeforeParentChild.externalState === "stopped",
      `row=${JSON.stringify(stoppedBeforeParentChild)}`,
    );
    await writeChildSessionFile(
      join(projectSessionDir, `${stoppedBeforeParentId}.jsonl`),
      stoppedBeforeParentId,
      project.path,
    );
    const stoppedAfterParentList = await registry.listSessionsForProject(project.id, project.path);
    assert(
      "stopped child remains nested after its delayed parent is discovered",
      stoppedAfterParentList.some((s) => s.sessionId === stoppedBeforeParentId) &&
        stoppedAfterParentList.find((s) => s.sessionId === stoppedBeforeParentChildId)
          ?.parentSessionId === stoppedBeforeParentId,
    );

    // 3. discoverSessionsOnDisk surfaces the parent AND both children.
    const discovered = await registry.discoverSessionsOnDisk(project.id, project.path);
    const ids = discovered.map((d) => d.sessionId);
    const expectedIds = [parent.sessionId, childA, childB];
    assert(
      "discoverSessionsOnDisk includes parent + 2 children",
      expectedIds.every((id) => ids.includes(id)),
      `got ${ids.join(",")} expected at least ${expectedIds.join(",")}`,
    );

    const childAEntry = discovered.find((d) => d.sessionId === childA);
    assert(
      "child A is tagged with parentSessionId",
      childAEntry?.parentSessionId === parent.sessionId,
      `parentSessionId=${childAEntry?.parentSessionId}`,
    );
    assert(
      "child A is tagged with the runId",
      childAEntry?.runId === runId,
      `runId=${childAEntry?.runId}`,
    );

    const parentEntry = discovered.find((d) => d.sessionId === parent.sessionId);
    assert(
      "parent session has no parentSessionId / runId tagging",
      parentEntry?.parentSessionId === undefined && parentEntry?.runId === undefined,
    );

    // 3b. Mixed hierarchy regression: orchestration workers are top-level
    // sessions whose supervisor link is overlaid from session-orchestration.json,
    // while pi-subagents children are discovered from disk below their parent.
    // When a worker uses a subagent, both links must coexist so the sidebar can
    // render: orchestrator -> worker -> subagent.
    const orchestrator = await registry.createSession(project.id, project.path);
    appendFixtureMessage(orchestrator, "orchestrator fixture");
    const worker = await registry.createSession(project.id, project.path);
    appendFixtureMessage(worker, "worker fixture");
    await orchestrationStore.enableSupervisor(orchestrator.sessionId);
    await orchestrationStore.registerWorker({
      supervisorId: orchestrator.sessionId,
      workerId: worker.sessionId,
    });
    const workerSubagentId = randomUUID();
    const workerSubagentRunId = "run-" + randomUUID().slice(0, 8);
    await writeChildSessionFile(
      join(projectSessionDir, worker.sessionId, workerSubagentRunId, `${workerSubagentId}.jsonl`),
      workerSubagentId,
      project.path,
    );
    const mixedList = await registry.listSessionsForProject(project.id, project.path);
    const workerRow = mixedList.find((s) => s.sessionId === worker.sessionId);
    const workerSubagentRow = mixedList.find((s) => s.sessionId === workerSubagentId);
    assert(
      "orchestration worker is nested under orchestrator in unified list",
      workerRow?.parentSessionId === orchestrator.sessionId,
      `parentSessionId=${workerRow?.parentSessionId}`,
    );
    assert(
      "worker subagent remains nested under the worker in unified list",
      workerSubagentRow?.parentSessionId === worker.sessionId &&
        workerSubagentRow?.runId === workerSubagentRunId,
      `parentSessionId=${workerSubagentRow?.parentSessionId} runId=${workerSubagentRow?.runId}`,
    );

    // 4. findSessionLocation resolves the child to its project.
    const loc = await registry.findSessionLocation(childA);
    assert(
      "findSessionLocation finds the child's project",
      loc?.projectId === project.id && loc?.workspacePath === project.path,
      `loc=${JSON.stringify(loc)}`,
    );

    // 5. Authoritative pi-subagents status.json marks queued/running children as
    // externally live without polluting the pi-forge live registry.
    await mkdir(join(subagentsExternal.SUBAGENTS_ASYNC_DIR, runId), { recursive: true });
    await writeFile(
      join(subagentsExternal.SUBAGENTS_ASYNC_DIR, runId, "status.json"),
      JSON.stringify({
        runId,
        sessionId: parent.session.sessionFile ?? parent.sessionId,
        state: "running",
        sessionFile: childAPath,
        steps: [{ sessionFile: childAPath }, { sessionFile: childBPath }],
      }),
      "utf8",
    );
    const activeList = await registry.listSessionsForProject(project.id, project.path);
    const activeChild = activeList.find((s) => s.sessionId === childA);
    const activeChildB = activeList.find((s) => s.sessionId === childB);
    assert(
      "running pi-subagents child isExternalLive=true but isLive=false",
      activeChild?.isExternalLive === true &&
        activeChild?.isLive === false &&
        activeChild.externalState === "running",
      `row=${JSON.stringify(activeChild)}`,
    );
    assert(
      "multiple background children share parent activity and remain nested",
      activeChildB?.isExternalLive === true &&
        activeChildB.parentSessionId === parent.sessionId &&
        activeList.filter(
          (s) => s.parentSessionId === parent.sessionId && s.isExternalLive === true,
        ).length === 2,
      `childB=${JSON.stringify(activeChildB)}`,
    );
    try {
      await registry.resumeSession(childA, project.id, project.path);
      assert(
        "resumeSession rejects externally running child",
        false,
        "resume unexpectedly succeeded",
      );
    } catch (err) {
      assert(
        "resumeSession rejects externally running child",
        err instanceof Error && err.name === "ExternalSubagentActiveError",
        `err=${err instanceof Error ? err.name : String(err)}`,
      );
    }
    await writeFile(
      join(subagentsExternal.SUBAGENTS_ASYNC_DIR, runId, "status.json"),
      JSON.stringify({
        runId,
        sessionId: parent.session.sessionFile ?? parent.sessionId,
        state: "complete",
        sessionFile: childAPath,
      }),
      "utf8",
    );
    await subagentsExternal.deliverExternalSubagentCompletionForRun(runId);
    const notifyBeforeResult = parent.session.messages?.find(
      (m) =>
        typeof m === "object" &&
        m !== null &&
        (m as { customType?: unknown }).customType === "subagent-notify",
    );
    assert(
      "terminal status waits for async result before notifying parent",
      notifyBeforeResult === undefined,
      `message=${JSON.stringify(notifyBeforeResult)}`,
    );

    await mkdir(subagentsExternal.SUBAGENTS_RESULTS_DIR, { recursive: true });
    await writeFile(
      join(subagentsExternal.SUBAGENTS_RESULTS_DIR, `${runId}.json`),
      JSON.stringify({
        runId,
        sessionId: parent.sessionId,
        agent: "reviewer",
        success: true,
        results: [{ agent: "reviewer", finalOutput: "done", sessionFile: childAPath }],
      }),
      "utf8",
    );
    await subagentsExternal.deliverExternalSubagentCompletionForRun(runId);
    await subagentsExternal.deliverExternalSubagentCompletionForRun(runId);
    const completeNotifications = (parent.session.messages ?? []).filter(
      (m) =>
        typeof m === "object" &&
        m !== null &&
        (m as { customType?: unknown }).customType === "subagent-notify" &&
        (m as { details?: { runId?: unknown; state?: unknown } }).details?.runId === runId &&
        (m as { details?: { runId?: unknown; state?: unknown } }).details?.state === "complete",
    ) as { content?: unknown }[];
    const notifyMessage = completeNotifications[0];
    assert(
      "complete async notification is renderable and exactly once",
      completeNotifications.length === 1 &&
        typeof notifyMessage?.content === "string" &&
        notifyMessage.content.includes("Background task completed") &&
        notifyMessage.content.includes("done"),
      `messages=${JSON.stringify(completeNotifications)}`,
    );

    const completeList = await registry.listSessionsForProject(project.id, project.path);
    const completeChild = completeList.find((s) => s.sessionId === childA);
    assert(
      "completion-before-discovery status clears activity but preserves the parent link",
      completeChild?.isExternalLive === false &&
        completeChild.externalState === "complete" &&
        completeChild.parentSessionId === parent.sessionId,
      `row=${JSON.stringify(completeChild)}`,
    );

    // 6. resumeSession opens the completed child as a LiveSession (registry hit).
    const resumed = await registry.resumeSession(childA, project.id, project.path);
    assert(
      "resumeSession returns a LiveSession for the child",
      resumed.sessionId === childA,
      `got ${resumed.sessionId}`,
    );

    await writeFile(
      join(subagentsExternal.SUBAGENTS_ASYNC_DIR, runId, "status.json"),
      JSON.stringify({
        runId,
        sessionId: parent.session.sessionFile ?? parent.sessionId,
        state: "running",
        sessionFile: childAPath,
      }),
      "utf8",
    );
    try {
      await registry.resumeSessionById(childA);
      assert(
        "resumeSessionById rejects and removes existing live child when status becomes running",
        false,
        "resume unexpectedly succeeded",
      );
    } catch (err) {
      assert(
        "resumeSessionById rejects and removes existing live child when status becomes running",
        err instanceof Error &&
          err.name === "ExternalSubagentActiveError" &&
          registry.getSession(childA) === undefined,
        `err=${err instanceof Error ? err.name : String(err)} live=${registry.getSession(childA) !== undefined}`,
      );
    }
    await writeFile(
      join(subagentsExternal.SUBAGENTS_ASYNC_DIR, runId, "status.json"),
      JSON.stringify({
        runId,
        sessionId: parent.session.sessionFile ?? parent.sessionId,
        state: "complete",
        sessionFile: childAPath,
      }),
      "utf8",
    );

    // 6b. Terminal scans dispatch a single state-specific sidebar invalidation
    // plus one durable notification. Calling each delivery path twice mirrors
    // watcher/poll bursts and catches the old terminal-state + stale-complete
    // event sequence.
    for (const terminalState of ["complete", "failed", "stopped"] as const) {
      const terminalRunId = `${terminalState}-${randomUUID().slice(0, 8)}`;
      const eventStart = parentListChanges.length;
      await mkdir(join(subagentsExternal.SUBAGENTS_ASYNC_DIR, terminalRunId), { recursive: true });
      await writeFile(
        join(subagentsExternal.SUBAGENTS_ASYNC_DIR, terminalRunId, "status.json"),
        JSON.stringify({
          runId: terminalRunId,
          sessionId: parent.sessionId,
          state: terminalState,
        }),
        "utf8",
      );
      await writeFile(
        join(subagentsExternal.SUBAGENTS_RESULTS_DIR, `${terminalRunId}.json`),
        JSON.stringify({
          runId: terminalRunId,
          sessionId: parent.sessionId,
          agent: "reviewer",
          success: terminalState !== "failed",
          state: terminalState,
          summary: `${terminalState} fixture`,
        }),
        "utf8",
      );
      await subagentsExternal.deliverExternalSubagentSessionListChange(terminalRunId);
      await subagentsExternal.deliverExternalSubagentSessionListChange(terminalRunId);
      await subagentsExternal.deliverExternalSubagentCompletionForRun(terminalRunId);
      await subagentsExternal.deliverExternalSubagentCompletionForRun(terminalRunId);
      const notifications = (parent.session.messages ?? []).filter((message) => {
        if (typeof message !== "object" || message === null) return false;
        const details = (message as { details?: unknown }).details;
        return (
          typeof details === "object" &&
          details !== null &&
          (details as { runId?: unknown; state?: unknown }).runId === terminalRunId &&
          (details as { runId?: unknown; state?: unknown }).state === terminalState
        );
      });
      const lifecycleReasons = parentListChanges
        .slice(eventStart)
        .filter((event) => event.type === "session_list_changed")
        .map((event) => event.reason);
      assert(
        `${terminalState} completion notification is durable and exactly once`,
        notifications.length === 1,
        `notifications=${JSON.stringify(notifications)}`,
      );
      assert(
        `${terminalState} terminal scan has one state-specific sidebar event`,
        JSON.stringify(lifecycleReasons) === JSON.stringify([`subagent_async_${terminalState}`]),
        `events=${JSON.stringify(lifecycleReasons)}`,
      );
    }
    // 6c. After an interrupted pi-subagents 0.37 run is explicitly stopped,
    // its result artifact can retain the earlier paused state while status.json
    // advances to stopped. Status is authoritative for the persisted/reloaded
    // sidebar state and terminal parent notification.
    const pausedThenStoppedRunId = `paused-then-stopped-${randomUUID().slice(0, 8)}`;
    const pausedThenStoppedChildId = randomUUID();
    const pausedThenStoppedChildPath = join(
      projectSessionDir,
      parent.sessionId,
      pausedThenStoppedRunId,
      `${pausedThenStoppedChildId}.jsonl`,
    );
    await writeChildSessionFile(pausedThenStoppedChildPath, pausedThenStoppedChildId, project.path);
    const pausedThenStoppedStatusPath = join(
      subagentsExternal.SUBAGENTS_ASYNC_DIR,
      pausedThenStoppedRunId,
      "status.json",
    );
    const pausedThenStoppedEventStart = parentListChanges.length;
    await mkdir(join(subagentsExternal.SUBAGENTS_ASYNC_DIR, pausedThenStoppedRunId), {
      recursive: true,
    });
    await writeFile(
      pausedThenStoppedStatusPath,
      JSON.stringify({
        runId: pausedThenStoppedRunId,
        sessionId: parent.sessionId,
        state: "paused",
        sessionFile: pausedThenStoppedChildPath,
      }),
      "utf8",
    );
    await writeFile(
      join(subagentsExternal.SUBAGENTS_RESULTS_DIR, `${pausedThenStoppedRunId}.json`),
      JSON.stringify({
        runId: pausedThenStoppedRunId,
        sessionId: parent.sessionId,
        agent: "reviewer",
        success: false,
        state: "paused",
        summary: "paused fixture",
      }),
      "utf8",
    );
    await subagentsExternal.deliverExternalSubagentSessionListChange(pausedThenStoppedRunId);
    await subagentsExternal.deliverExternalSubagentCompletionForRun(pausedThenStoppedRunId);
    await writeFile(
      pausedThenStoppedStatusPath,
      JSON.stringify({
        runId: pausedThenStoppedRunId,
        sessionId: parent.sessionId,
        state: "stopped",
        sessionFile: pausedThenStoppedChildPath,
      }),
      "utf8",
    );
    await subagentsExternal.deliverExternalSubagentSessionListChange(pausedThenStoppedRunId);
    await subagentsExternal.deliverExternalSubagentSessionListChange(pausedThenStoppedRunId);
    await subagentsExternal.deliverExternalSubagentCompletionForRun(pausedThenStoppedRunId);
    await subagentsExternal.deliverExternalSubagentCompletionForRun(pausedThenStoppedRunId);
    const persistedStoppedStatus = JSON.parse(
      await readFile(pausedThenStoppedStatusPath, "utf8"),
    ) as {
      state?: unknown;
    };
    const pausedThenStoppedReloadedList = await registry.listSessionsForProject(
      project.id,
      project.path,
    );
    const pausedThenStoppedNotifications = (parent.session.messages ?? []).filter((message) => {
      if (typeof message !== "object" || message === null) return false;
      const details = (message as { details?: unknown }).details;
      return (
        typeof details === "object" &&
        details !== null &&
        (details as { runId?: unknown }).runId === pausedThenStoppedRunId
      );
    }) as { content?: unknown; details?: { state?: unknown } }[];
    const pausedThenStoppedReasons = parentListChanges
      .slice(pausedThenStoppedEventStart)
      .filter((event) => event.type === "session_list_changed")
      .map((event) => event.reason);
    const pausedThenStoppedChild = pausedThenStoppedReloadedList.find(
      (session) => session.sessionId === pausedThenStoppedChildId,
    );
    assert(
      "paused then stopped persists stopped as the authoritative reloaded child state",
      persistedStoppedStatus.state === "stopped" &&
        pausedThenStoppedChild?.externalState === "stopped" &&
        pausedThenStoppedChild.isExternalLive === false &&
        pausedThenStoppedReloadedList
          .find((session) => session.sessionId === parent.sessionId)
          ?.backgroundSubagentRuns?.some(
            (run) => run.runId === pausedThenStoppedRunId && run.state === "stopped",
          ) === true,
      `status=${JSON.stringify(persistedStoppedStatus)} child=${JSON.stringify(pausedThenStoppedChild)}`,
    );
    assert(
      "paused then stopped emits each parent/sidebar lifecycle transition exactly once",
      JSON.stringify(pausedThenStoppedReasons) ===
        JSON.stringify(["subagent_async_paused", "subagent_async_stopped"]),
      `events=${JSON.stringify(pausedThenStoppedReasons)}`,
    );
    assert(
      "paused then stopped emits one correctly labeled stopped notification despite stale paused result",
      pausedThenStoppedNotifications.filter((message) => message.details?.state === "paused")
        .length === 1 &&
        pausedThenStoppedNotifications.filter((message) => message.details?.state === "stopped")
          .length === 1 &&
        pausedThenStoppedNotifications.some(
          (message) =>
            message.details?.state === "stopped" &&
            typeof message.content === "string" &&
            message.content.includes("Background task stopped"),
        ),
      `notifications=${JSON.stringify(pausedThenStoppedNotifications)}`,
    );

    const terminalReloadList = await registry.listSessionsForProject(project.id, project.path);
    const terminalParentRuns = terminalReloadList.find(
      (s) => s.sessionId === parent.sessionId,
    )?.backgroundSubagentRuns;
    assert(
      "terminal status reload preserves terminal outcomes without active parent activity",
      terminalParentRuns !== undefined &&
        terminalParentRuns.length > 0 &&
        terminalParentRuns.every(
          (run) =>
            run.state === "complete" ||
            run.state === "failed" ||
            run.state === "paused" ||
            run.state === "stopped",
        ),
      `row=${JSON.stringify(terminalReloadList.find((s) => s.sessionId === parent.sessionId))}`,
    );

    // 7. REALISTIC pi-subagents layout: the plugin's
    // `getSubagentSessionRoot` names the child dir using the parent
    // FILE's full basename (timestamp + id), not the bare parent id.
    // The discovery has to map basename → parent's actual sessionId
    // via the top-level scan, otherwise the child's `parentSessionId`
    // ends up as the timestamped string and SessionList grouping
    // silently fails. This is the regression that motivated the
    // basenameToParentId map; without it, this assertion would tag
    // the child with `2026-...-realistic-parent` instead of
    // `realistic-parent`.
    const realisticParentId = "realistic-parent-" + randomUUID().slice(0, 6);
    const realisticBasename = "2026-05-07T12-34-56-000Z_" + realisticParentId;
    const realisticParentPath = join(projectSessionDir, `${realisticBasename}.jsonl`);
    await writeChildSessionFile(realisticParentPath, realisticParentId, project.path);
    const realisticRunId = "run-" + randomUUID().slice(0, 6);
    const realisticChildId = randomUUID();
    const realisticChildPath = join(
      projectSessionDir,
      realisticBasename, // dir named after parent's full basename, NOT just the id
      realisticRunId,
      `${realisticChildId}.jsonl`,
    );
    await writeChildSessionFile(realisticChildPath, realisticChildId, project.path);
    const rediscovered = await registry.discoverSessionsOnDisk(project.id, project.path);
    const realisticChildEntry = rediscovered.find((d) => d.sessionId === realisticChildId);
    assert(
      "realistic-layout child was discovered",
      realisticChildEntry !== undefined,
      `child id=${realisticChildId} not in ${rediscovered.map((d) => d.sessionId).join(",")}`,
    );
    assert(
      "realistic-layout child's parentSessionId resolves via basename map",
      realisticChildEntry?.parentSessionId === realisticParentId,
      `got parentSessionId=${realisticChildEntry?.parentSessionId} expected=${realisticParentId}`,
    );

    // 8a. DEEP layout (parallel/chain mode):
    //     <basename>/<runId>/run-N/session.jsonl. Three dir levels
    //     under the parent — observed in the wild on real
    //     pi-subagents installs. Discovery has to walk past the runId
    //     dir to find the actual session.jsonl.
    const deepParentId = "deep-parent-" + randomUUID().slice(0, 6);
    const deepBasename = "2026-05-07T14-00-00-000Z_" + deepParentId;
    const deepParentPath = join(projectSessionDir, `${deepBasename}.jsonl`);
    await writeChildSessionFile(deepParentPath, deepParentId, project.path);
    const deepRunId = randomUUID().slice(0, 8);
    const deepChildId = randomUUID();
    const deepChildPath = join(
      projectSessionDir,
      deepBasename,
      deepRunId,
      "run-0",
      "session.jsonl",
    );
    await writeChildSessionFile(deepChildPath, deepChildId, project.path);
    const literalChildSource = await readFile(deepChildPath, "utf8");
    const reDeep = await registry.discoverSessionsOnDisk(project.id, project.path);
    const deepChildEntry = reDeep.find((d) => d.sessionId === deepChildId);
    assert(
      "literal deep-layout child (basename/runId/run-N/session.jsonl) was discovered",
      deepChildEntry !== undefined,
      `child id=${deepChildId} not in ${reDeep.map((d) => d.sessionId).join(",")}`,
    );
    assert(
      "literal child discovery does not rewrite the source JSONL",
      (await readFile(deepChildPath, "utf8")) === literalChildSource,
    );
    assert(
      "deep-layout child's parentSessionId resolves via basename map",
      deepChildEntry?.parentSessionId === deepParentId,
      `got parentSessionId=${deepChildEntry?.parentSessionId} expected=${deepParentId}`,
    );
    assert(
      "deep-layout child's runId reflects the full intermediate path",
      deepChildEntry?.runId === `${deepRunId}/run-0` ||
        deepChildEntry?.runId === `${deepRunId}\\run-0`,
      `got runId=${deepChildEntry?.runId}`,
    );

    const rootCwdChildId = randomUUID();
    const rootCwdLiteralPath = join(
      projectSessionDir,
      deepBasename,
      deepRunId,
      "run-1",
      "session.jsonl",
    );
    await writeChildSessionFile(rootCwdLiteralPath, rootCwdChildId, workspacePath);
    const rootCwdLiteralSource = await readFile(rootCwdLiteralPath, "utf8");
    const refreshedRootCwdDiscovery = await registry.refreshProjectSessionIndex(
      project.id,
      project.path,
    );
    const rootCwdChild = refreshedRootCwdDiscovery.find((d) => d.sessionId === rootCwdChildId);
    assert(
      "explicit index refresh discovers exact known run-N child at configured root cwd",
      rootCwdChild?.parentSessionId === deepParentId &&
        (rootCwdChild.runId === `${deepRunId}/run-1` ||
          rootCwdChild.runId === `${deepRunId}\\run-1`),
      `entry=${JSON.stringify(rootCwdChild)}`,
    );
    const rootCwdUnified = await registry.listSessionsForProject(project.id, project.path);
    assert(
      "root-cwd child projects into the nested sidebar listing after refresh",
      rootCwdUnified.some(
        (session) =>
          session.sessionId === rootCwdChildId && session.parentSessionId === deepParentId,
      ),
    );
    assert(
      "accepted root-cwd literal parsing remains non-mutating",
      (await readFile(rootCwdLiteralPath, "utf8")) === rootCwdLiteralSource,
    );

    const malformedLiteralPath = join(
      projectSessionDir,
      deepBasename,
      deepRunId,
      "run-2",
      "session.jsonl",
    );
    const foreignLiteralPath = join(
      projectSessionDir,
      deepBasename,
      deepRunId,
      "run-3",
      "session.jsonl",
    );
    const unknownParentLiteralPath = join(
      projectSessionDir,
      "missing-parent-basename",
      deepRunId,
      "run-4",
      "session.jsonl",
    );
    const badRunPathLiteralPath = join(
      projectSessionDir,
      deepBasename,
      deepRunId,
      "not-run-5",
      "session.jsonl",
    );
    const descendantCwdLiteralPath = join(
      projectSessionDir,
      deepBasename,
      deepRunId,
      "run-6",
      "session.jsonl",
    );
    await writeChildSessionFile(malformedLiteralPath, "invalid session id", project.path);
    await writeChildSessionFile(foreignLiteralPath, randomUUID(), join(workspacePath, "other"));
    await writeChildSessionFile(unknownParentLiteralPath, randomUUID(), workspacePath);
    await writeChildSessionFile(badRunPathLiteralPath, randomUUID(), workspacePath);
    await writeChildSessionFile(
      descendantCwdLiteralPath,
      randomUUID(),
      join(workspacePath, "nested"),
    );
    const malformedLiteralSource = await readFile(malformedLiteralPath, "utf8");
    const foreignLiteralSource = await readFile(foreignLiteralPath, "utf8");
    const validatedLiteralDiscovery = await registry.discoverSessionsOnDisk(
      project.id,
      project.path,
    );
    assert(
      "literal child parser rejects malformed session ids and foreign workspace cwd",
      !validatedLiteralDiscovery.some((d) =>
        [
          malformedLiteralPath,
          foreignLiteralPath,
          unknownParentLiteralPath,
          badRunPathLiteralPath,
          descendantCwdLiteralPath,
        ].includes(d.path ?? ""),
      ),
    );
    assert(
      "rejected literal children are never rewritten",
      (await readFile(malformedLiteralPath, "utf8")) === malformedLiteralSource &&
        (await readFile(foreignLiteralPath, "utf8")) === foreignLiteralSource,
    );

    // 8b. FLAT layout (no runId subdir): some pi-subagents run modes
    // write children directly under <parentBasename>/, not under
    // <parentBasename>/<runId>/. Discovery must surface these too.
    const flatParentId = "flat-parent-" + randomUUID().slice(0, 6);
    const flatBasename = "2026-05-07T13-00-00-000Z_" + flatParentId;
    const flatParentPath = join(projectSessionDir, `${flatBasename}.jsonl`);
    await writeChildSessionFile(flatParentPath, flatParentId, project.path);
    const flatChildId = randomUUID();
    const flatChildPath = join(projectSessionDir, flatBasename, `${flatChildId}.jsonl`);
    await writeChildSessionFile(flatChildPath, flatChildId, project.path);
    const reFlat = await registry.discoverSessionsOnDisk(project.id, project.path);
    const flatChildEntry = reFlat.find((d) => d.sessionId === flatChildId);
    assert(
      "flat-layout child (no runId subdir) was discovered",
      flatChildEntry !== undefined,
      `child id=${flatChildId} not in ${reFlat.map((d) => d.sessionId).join(",")}`,
    );
    assert(
      "flat-layout child's parentSessionId resolves and runId is undefined",
      flatChildEntry?.parentSessionId === flatParentId && flatChildEntry?.runId === undefined,
      `parentSessionId=${flatChildEntry?.parentSessionId} runId=${flatChildEntry?.runId}`,
    );

    // 9. Cascade-delete: deleting a parent session also wipes its
    // pi-subagents sibling directory and any nested children, so the
    // sidebar doesn't accumulate orphan child sessions whose parent
    // is gone. We use the deep-layout fixture because it exercises
    // the full <basename>/<runId>/run-N/<child>.jsonl tree the
    // recursive rm has to clear.
    //
    // We ALSO resume the deep child first so it's a live registry
    // entry (matching the bug case: user opened a sub-agent session
    // in the UI, then deleted its parent). The cascade has to dispose
    // the live LiveSession AND remove the JSONL — without the
    // dispose, the registry holds a zombie pointing at a deleted
    // file and any attached SSE clients keep emitting events that
    // can't be persisted.
    await registry.resumeSession(deepChildId, project.id, project.path);
    assert(
      "deep child is live in the registry before cascade",
      registry.getSession(deepChildId) !== undefined,
    );
    const cascadeStatus = await registry.deleteColdSession(deepParentId);
    assert("deleteColdSession on the deep parent returns 'deleted'", cascadeStatus === "deleted");
    assert(
      "deep child's LiveSession was disposed by the cascade",
      registry.getSession(deepChildId) === undefined,
    );
    const reAfterCascade = await registry.discoverSessionsOnDisk(project.id, project.path);
    assert(
      "deep-layout child is gone after parent delete (cascade)",
      reAfterCascade.find((d) => d.sessionId === deepChildId) === undefined,
      `child still discovered: ${reAfterCascade.map((d) => d.sessionId).join(",")}`,
    );
    assert(
      "deep-layout parent is gone after parent delete",
      reAfterCascade.find((d) => d.sessionId === deepParentId) === undefined,
    );
  } finally {
    await registry.disposeAllSessions();
    // Clean every temp dir we created. Safe to ignore failures —
    // mkdtemp dirs are isolated per test run.
    await rm(workspacePath, { recursive: true, force: true }).catch(() => undefined);
  }

  if (failures > 0) {
    console.log(`\n[test-subagent-discovery] FAIL — ${failures} assertion(s) failed`);
    process.exit(1);
  }
  console.log("\n[test-subagent-discovery] PASS");
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
