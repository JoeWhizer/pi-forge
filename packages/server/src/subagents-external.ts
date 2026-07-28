import { existsSync, watch, type FSWatcher } from "node:fs";
import { open, readdir, readFile, stat } from "node:fs/promises";
import { join } from "node:path";
import * as os from "node:os";
import { SessionManager } from "@earendil-works/pi-coding-agent";
import type { AgentMessage } from "@earendil-works/pi-agent-core";
import { getSession } from "./session-registry.js";

export type ExternalSubagentState =
  | "queued"
  | "running"
  | "complete"
  | "failed"
  | "paused"
  | "stopped";

export interface ExternalSubagentStatus {
  runId: string;
  rootRunId: string;
  state: ExternalSubagentState;
  isExternalLive: boolean;
  statusPath: string;
  resultPath?: string;
  parentSessionId?: string;
  sessionFile?: string;
}

export interface ExternalSubagentFleetChild {
  /** Stable within a run even before the child session file exists. */
  childId: string;
  state: ExternalSubagentState;
  agent?: string;
  model?: string;
  sessionId?: string;
  startedAt?: number;
  endedAt?: number;
  durationMs?: number;
  error?: string;
}

export interface ExternalSubagentFleetRun {
  runId: string;
  parentSessionId?: string;
  state: ExternalSubagentState;
  mode?: string;
  model?: string;
  startedAt?: number;
  endedAt?: number;
  lastActivityAt?: number;
  durationMs?: number;
  error?: string;
  children: ExternalSubagentFleetChild[];
}

interface AsyncStatusStep {
  agent?: string;
  status?: string;
  model?: string;
  sessionFile?: string;
  startedAt?: number;
  endedAt?: number;
  durationMs?: number;
  error?: string;
}

interface AsyncStatusFile {
  runId?: string;
  sessionId?: string;
  mode?: string;
  state?: ExternalSubagentState;
  sessionFile?: string;
  startedAt?: number;
  endedAt?: number;
  lastActivityAt?: number;
  lastUpdate?: number;
  durationMs?: number;
  error?: string;
  steps?: AsyncStatusStep[];
}

interface AsyncResultFile {
  id?: string;
  runId?: string;
  agent?: string;
  success?: boolean;
  summary?: string;
  state?: string;
  sessionId?: string;
  sessionFile?: string;
  results?: {
    agent?: string;
    output?: string;
    finalOutput?: string;
    success?: boolean;
    error?: string;
    sessionFile?: string;
  }[];
}

function sanitizeTempScopeSegment(value: string): string {
  const sanitized = value
    .trim()
    .replace(/[^A-Za-z0-9._-]+/g, "-")
    .replace(/^-+|-+$/g, "");
  return sanitized || "unknown";
}

function resolveTempScopeId(): string {
  if (typeof process.getuid === "function") return `uid-${process.getuid()}`;
  for (const key of ["USERNAME", "USER", "LOGNAME"] as const) {
    const value = process.env[key];
    if (value) return `user-${sanitizeTempScopeSegment(value)}`;
  }
  try {
    const username = os.userInfo().username;
    if (username) return `user-${sanitizeTempScopeSegment(username)}`;
  } catch {
    // fall through
  }
  const homedir = process.env.USERPROFILE ?? process.env.HOME ?? os.homedir();
  if (homedir) return `home-${sanitizeTempScopeSegment(homedir)}`;
  return "shared";
}

export const SUBAGENTS_TEMP_ROOT = join(os.tmpdir(), `pi-subagents-${resolveTempScopeId()}`);
export const SUBAGENTS_RESULTS_DIR = join(SUBAGENTS_TEMP_ROOT, "async-subagent-results");
export const SUBAGENTS_ASYNC_DIR = join(SUBAGENTS_TEMP_ROOT, "async-subagent-runs");

const TERMINAL_STATES = new Set<ExternalSubagentState>(["complete", "failed", "paused", "stopped"]);
const ACTIVE_STATES = new Set<ExternalSubagentState>(["queued", "running"]);
// Keep terminal outcomes in the parent projection too. An interrupt result
// can only resolve against its exact run id, including before child discovery.
const PARENT_VISIBLE_STATES = new Set<ExternalSubagentState>([
  "queued",
  "running",
  "complete",
  "failed",
  "paused",
  "stopped",
]);
const deliveredCompletionKeys = new Set<string>();
const fleetRunCache = new Map<string, { stamp: string; run: ExternalSubagentFleetRun }>();
// Status files are rewritten repeatedly while a run is active. Remember every
// delivered state transition so a poll/watch burst creates one sidebar update,
// while queued → running → terminal transitions still propagate individually.
const deliveredSessionListKeys = new Set<string>();
let watcherStarted = false;
let asyncWatcher: FSWatcher | undefined;
let resultsWatcher: FSWatcher | undefined;
let scanTimer: NodeJS.Timeout | undefined;

function rootRunId(runId: string | undefined): string | undefined {
  return runId?.split(/[\\/]/, 1)[0];
}

function isExternalState(value: unknown): value is ExternalSubagentState {
  return (
    value === "queued" ||
    value === "running" ||
    value === "complete" ||
    value === "failed" ||
    value === "paused" ||
    value === "stopped"
  );
}

async function readJson<T>(path: string): Promise<T | undefined> {
  try {
    return JSON.parse(await readFile(path, "utf8")) as T;
  } catch {
    return undefined;
  }
}

async function readStatusByRoot(
  root: string,
  rawStatus?: AsyncStatusFile,
): Promise<ExternalSubagentStatus | undefined> {
  const statusPath = join(SUBAGENTS_ASYNC_DIR, root, "status.json");
  const status = rawStatus ?? (await readJson<AsyncStatusFile>(statusPath));
  if (!isExternalState(status?.state)) return undefined;
  const resultPath = join(SUBAGENTS_RESULTS_DIR, `${root}.json`);
  const out: ExternalSubagentStatus = {
    runId: status.runId ?? root,
    rootRunId: root,
    state: status.state,
    isExternalLive: ACTIVE_STATES.has(status.state),
    statusPath,
  };
  if (existsSync(resultPath)) out.resultPath = resultPath;
  if (typeof status.sessionId === "string") {
    // pi-subagents 0.37 can persist the parent session *file* here instead
    // of its UUID. Resolve that exact file header before exposing topology to
    // the client; a bare id remains valid across reloads when the parent is
    // no longer live.
    const parentId = await sessionIdFromSessionReference(status.sessionId);
    if (parentId !== undefined) out.parentSessionId = parentId;
    else if (!status.sessionId.includes("/") && !status.sessionId.includes("\\")) {
      out.parentSessionId = status.sessionId;
    }
  }
  if (typeof status.sessionFile === "string") out.sessionFile = status.sessionFile;
  return out;
}

function statusMatchesSession(
  status: ExternalSubagentStatus,
  sessionPath: string | undefined,
): boolean {
  if (sessionPath === undefined) return true;
  return status.sessionFile === sessionPath;
}

async function readStatusRoots(): Promise<string[]> {
  try {
    return await readdir(SUBAGENTS_ASYNC_DIR);
  } catch {
    return [];
  }
}

function finiteNonNegative(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) && value >= 0 ? value : undefined;
}

function nonEmptyString(value: unknown, maxLength = 2000): string | undefined {
  if (typeof value !== "string") return undefined;
  const trimmed = value.trim();
  if (trimmed.length === 0) return undefined;
  return trimmed.length <= maxLength ? trimmed : `${trimmed.slice(0, maxLength - 1)}…`;
}

function durationFrom(
  durationMs: unknown,
  startedAt: number | undefined,
  endedAt: number | undefined,
): number | undefined {
  const explicit = finiteNonNegative(durationMs);
  if (explicit !== undefined) return explicit;
  if (startedAt === undefined) return undefined;
  return Math.max(0, (endedAt ?? Date.now()) - startedAt);
}

async function fleetCacheStamp(
  statusPath: string,
  resultPath: string,
): Promise<string | undefined> {
  try {
    const statusInfo = await stat(statusPath);
    let resultStamp = "missing";
    try {
      const resultInfo = await stat(resultPath);
      resultStamp = `${resultInfo.mtimeMs}:${resultInfo.size}`;
    } catch {
      // A terminal status can land before its optional result artifact.
    }
    return `${statusInfo.mtimeMs}:${statusInfo.size}:${resultStamp}`;
  } catch {
    return undefined;
  }
}

async function fleetChildFrom(
  runId: string,
  index: number,
  runState: ExternalSubagentState,
  step: AsyncStatusStep | undefined,
  result: NonNullable<AsyncResultFile["results"]>[number] | undefined,
): Promise<ExternalSubagentFleetChild> {
  const state = isExternalState(step?.status) ? step.status : runState;
  const startedAt = finiteNonNegative(step?.startedAt);
  const endedAt = finiteNonNegative(step?.endedAt);
  const sessionFile = nonEmptyString(step?.sessionFile ?? result?.sessionFile, 16_384);
  const sessionId = await sessionIdFromSessionReference(sessionFile);
  const child: ExternalSubagentFleetChild = {
    childId: `${runId}:${index}`,
    state,
  };
  const agent = nonEmptyString(step?.agent ?? result?.agent, 200);
  const model = nonEmptyString(step?.model, 300);
  const error = nonEmptyString(step?.error ?? result?.error);
  if (agent !== undefined) child.agent = agent;
  if (model !== undefined) child.model = model;
  if (sessionId !== undefined) child.sessionId = sessionId;
  if (startedAt !== undefined) child.startedAt = startedAt;
  if (endedAt !== undefined) child.endedAt = endedAt;
  const durationMs = durationFrom(step?.durationMs, startedAt, endedAt);
  if (durationMs !== undefined) child.durationMs = durationMs;
  if (error !== undefined) child.error = error;
  return child;
}

async function readFleetRun(root: string): Promise<ExternalSubagentFleetRun | undefined> {
  const statusPath = join(SUBAGENTS_ASYNC_DIR, root, "status.json");
  const resultPath = join(SUBAGENTS_RESULTS_DIR, `${root}.json`);
  const stamp = await fleetCacheStamp(statusPath, resultPath);
  if (stamp === undefined) return undefined;
  const cached = fleetRunCache.get(root);
  if (
    cached?.stamp === stamp &&
    cached.run.parentSessionId !== undefined &&
    cached.run.children.every((child) => child.sessionId !== undefined)
  ) {
    return cached.run;
  }

  const status = await readJson<AsyncStatusFile>(statusPath);
  if (!isExternalState(status?.state)) return undefined;
  const runId = nonEmptyString(status.runId, 500) ?? root;
  const parentSessionId = await sessionIdFromSessionReference(status.sessionId);
  const result = await readJson<AsyncResultFile>(resultPath);
  const statusSteps = Array.isArray(status.steps) ? status.steps : [];
  const resultSteps = Array.isArray(result?.results) ? result.results : [];
  const childCount = Math.max(statusSteps.length, resultSteps.length);
  const children = await Promise.all(
    Array.from({ length: childCount }, (_, index) =>
      fleetChildFrom(runId, index, status.state!, statusSteps[index], resultSteps[index]),
    ),
  );
  const startedAt = finiteNonNegative(status.startedAt);
  const endedAt = finiteNonNegative(status.endedAt);
  const run: ExternalSubagentFleetRun = { runId, state: status.state, children };
  const mode = nonEmptyString(status.mode, 100);
  const error =
    nonEmptyString(status.error) ?? children.find((child) => child.error !== undefined)?.error;
  const models = Array.from(
    new Set(
      children.map((child) => child.model).filter((model): model is string => model !== undefined),
    ),
  );
  if (parentSessionId !== undefined) run.parentSessionId = parentSessionId;
  if (mode !== undefined) run.mode = mode;
  const onlyModel = models.length === 1 ? models[0] : undefined;
  if (onlyModel !== undefined) run.model = onlyModel;
  if (startedAt !== undefined) run.startedAt = startedAt;
  if (endedAt !== undefined) run.endedAt = endedAt;
  const lastActivityAt = finiteNonNegative(status.lastActivityAt ?? status.lastUpdate);
  if (lastActivityAt !== undefined) run.lastActivityAt = lastActivityAt;
  const durationMs = durationFrom(status.durationMs, startedAt, endedAt);
  if (durationMs !== undefined) run.durationMs = durationMs;
  if (error !== undefined) run.error = error;

  // A status write changes mtime whenever lifecycle details change. Cache the
  // small, sanitized projection rather than repeatedly parsing potentially
  // large recent-output fields on every fleet poll.
  fleetRunCache.set(root, { stamp, run });
  return run;
}

/**
 * Read the pi-subagents lifecycle artifacts directly and return a sanitized,
 * stable-id fleet projection. Both active and terminal runs are retained;
 * malformed or partially-written status files are skipped until the next poll.
 */
export async function listExternalSubagentFleetRuns(): Promise<ExternalSubagentFleetRun[]> {
  const runs = (
    await Promise.all((await readStatusRoots()).map(async (root) => readFleetRun(root)))
  ).filter((run): run is ExternalSubagentFleetRun => run !== undefined);
  runs.sort((a, b) => {
    const aActive = ACTIVE_STATES.has(a.state) ? 1 : 0;
    const bActive = ACTIVE_STATES.has(b.state) ? 1 : 0;
    if (aActive !== bActive) return bActive - aActive;
    const aTime = a.lastActivityAt ?? a.endedAt ?? a.startedAt ?? 0;
    const bTime = b.lastActivityAt ?? b.endedAt ?? b.startedAt ?? 0;
    return bTime - aTime || a.runId.localeCompare(b.runId);
  });
  return runs;
}

function statusFileSessionPaths(status: AsyncStatusFile): string[] {
  const paths: string[] = [];
  if (typeof status.sessionFile === "string") paths.push(status.sessionFile);
  for (const step of status.steps ?? []) {
    if (typeof step.sessionFile === "string") paths.push(step.sessionFile);
  }
  return paths;
}

async function readStatusByRootForSessionPath(
  root: string,
  sessionPath: string,
): Promise<ExternalSubagentStatus | undefined> {
  const statusPath = join(SUBAGENTS_ASYNC_DIR, root, "status.json");
  const raw = await readJson<AsyncStatusFile>(statusPath);
  if (!isExternalState(raw?.state)) return undefined;
  if (!statusFileSessionPaths(raw).includes(sessionPath)) return undefined;
  const base = await readStatusByRoot(root);
  if (base === undefined) return undefined;
  return { ...base, sessionFile: sessionPath };
}

async function findExternalSubagentStatusForSessionPath(
  sessionPath: string | undefined,
): Promise<ExternalSubagentStatus | undefined> {
  if (sessionPath === undefined) return undefined;
  const roots = await readStatusRoots();
  for (const root of roots) {
    const status = await readStatusByRootForSessionPath(root, sessionPath);
    if (status !== undefined) return status;
  }
  return undefined;
}

export async function getExternalSubagentStatusForRun(
  runId: string | undefined,
): Promise<ExternalSubagentStatus | undefined> {
  const root = rootRunId(runId);
  if (root === undefined || root.length === 0) return undefined;
  return readStatusByRoot(root);
}

/**
 * Return every parent-visible async run owned by one parent session. This is
 * deliberately status-file based instead of child-session based: pi-subagents
 * creates the status file before its child JSONL is discoverable. Paused and
 * terminal runs stay visible so interrupt cards can resolve exact outcomes;
 * only queued/running runs are activity spinner work.
 */
export async function listExternalSubagentStatusesForParents(
  parentSessionIds: ReadonlySet<string>,
): Promise<Map<string, ExternalSubagentStatus[]>> {
  const byParent = new Map<string, ExternalSubagentStatus[]>();
  if (parentSessionIds.size === 0) return byParent;
  for (const root of await readStatusRoots()) {
    const statusPath = join(SUBAGENTS_ASYNC_DIR, root, "status.json");
    const rawStatus = await readJson<AsyncStatusFile>(statusPath);
    // Retain every valid status in the parent projection. Terminal outcomes
    // are needed to resolve an interrupt card before a child JSONL exists.
    if (!isExternalState(rawStatus?.state) || !PARENT_VISIBLE_STATES.has(rawStatus.state)) continue;
    const status = await readStatusByRoot(root, rawStatus);
    if (status?.parentSessionId === undefined || !parentSessionIds.has(status.parentSessionId))
      continue;
    const current = byParent.get(status.parentSessionId);
    if (current === undefined) byParent.set(status.parentSessionId, [status]);
    else current.push(status);
  }
  return byParent;
}

export async function getExternalSubagentStatusForSession(info: {
  runId?: string | undefined;
  path?: string | undefined;
}): Promise<ExternalSubagentStatus | undefined> {
  const status = await getExternalSubagentStatusForRun(info.runId);
  if (status !== undefined && statusMatchesSession(status, info.path)) return status;

  // pi-subagents async status run ids are not always the same as the nested
  // session directory segments that pi-forge discovers in the sidebar. In
  // current pi-subagents, status.json can identify the child by exact
  // `steps[].sessionFile` instead. That path match is the authoritative signal
  // for protecting an externally running child.
  return findExternalSubagentStatusForSessionPath(info.path);
}

export async function isExternallyActiveSubagentSession(info: {
  runId?: string | undefined;
  path?: string | undefined;
}): Promise<boolean> {
  const status = await getExternalSubagentStatusForSession(info);
  return status?.isExternalLive === true;
}

export function readSessionMessagesFromDisk(
  sessionPath: string,
  workspacePath: string,
): AgentMessage[] {
  const manager = SessionManager.open(sessionPath, undefined, workspacePath);
  return manager.buildSessionContext().messages;
}

function terminalNotificationState(
  status: ExternalSubagentStatus,
): "complete" | "failed" | "paused" | "stopped" {
  // status.json is the lifecycle authority. In particular, a stop can follow
  // a pause while the result artifact still reports its earlier paused state.
  if (status.state === "paused" || status.state === "stopped") return status.state;
  if (status.state === "failed") return "failed";
  return "complete";
}

function formatCompletionContent(
  result: AsyncResultFile | undefined,
  status: ExternalSubagentStatus,
  terminalState: ReturnType<typeof terminalNotificationState>,
): string {
  const state = terminalState === "complete" ? "completed" : terminalState;
  const agent = result?.agent ?? result?.results?.[0]?.agent ?? "subagent";
  const summary =
    result?.summary ??
    result?.results?.[0]?.finalOutput ??
    result?.results?.[0]?.output ??
    result?.results?.[0]?.error ??
    `(background run ${status.rootRunId} ${state})`;
  const sessionFile =
    result?.sessionFile ??
    result?.results?.find((r) => typeof r.sessionFile === "string")?.sessionFile ??
    status.sessionFile;
  return [
    `Background task ${state}: **${agent}**`,
    "",
    summary.trim() || "(no output)",
    sessionFile ? "" : undefined,
    sessionFile ? `Session file: ${sessionFile}` : undefined,
  ]
    .filter((line) => line !== undefined)
    .join("\n");
}

async function sessionIdFromSessionReference(ref: string | undefined): Promise<string | undefined> {
  if (ref === undefined) return undefined;
  if (getSession(ref) !== undefined) return ref;
  // pi-subagents persists either an absolute JSONL path or the stable session
  // id. Avoid a failing filesystem open for the common bare-id form.
  if (!ref.includes("/") && !ref.includes("\\") && !ref.endsWith(".jsonl")) return ref;
  try {
    // Session headers are the first JSONL line. Never load an entire parent
    // transcript just to resolve it: a project may have many old async runs
    // pointing at large parent files during sidebar reconstruction.
    const file = await open(ref, "r");
    try {
      const buffer = Buffer.alloc(8192);
      const { bytesRead } = await file.read(buffer, 0, buffer.length, 0);
      const firstLine = buffer.toString("utf8", 0, bytesRead).split(/\r?\n/, 1)[0];
      if (firstLine === undefined) return undefined;
      const header = JSON.parse(firstLine) as { type?: unknown; id?: unknown };
      return header.type === "session" && typeof header.id === "string" ? header.id : undefined;
    } finally {
      await file.close();
    }
  } catch {
    return undefined;
  }
}

function hasDeliveredCompletionMessage(
  messages: readonly AgentMessage[],
  root: string,
  state: ExternalSubagentState,
  content: string,
): boolean {
  return messages.some((message) => {
    if (message.role !== "custom" || message.customType !== "subagent-notify") return false;
    const details = message.details as
      | { source?: unknown; runId?: unknown; state?: unknown }
      | undefined;
    if (details?.source === "pi-subagents" && details.runId === root && details.state === state) {
      return true;
    }

    // Backward-compatible durable dedupe for notifications written before we
    // started persisting run metadata in details. This also covers SDK versions
    // that might omit details from rebuilt custom-message state. The formatted
    // completion includes the child session file when available, so exact
    // content matching is stable enough to prevent restart replays without
    // suppressing unrelated runs.
    return message.content === content;
  });
}

export async function deliverExternalSubagentCompletionForRun(root: string): Promise<void> {
  const status = await readStatusByRoot(root);
  if (status === undefined || !TERMINAL_STATES.has(status.state)) return;
  const resultPath = join(SUBAGENTS_RESULTS_DIR, `${root}.json`);
  const result = await readJson<AsyncResultFile>(resultPath);
  if (result === undefined) {
    // pi-subagents can write the terminal status before it writes the async
    // result file. Defer the parent notification until the result exists so
    // the durable chat message contains the child output instead of an early
    // placeholder that would then be deduped forever.
    return;
  }
  const parentId = await sessionIdFromSessionReference(result.sessionId ?? status.parentSessionId);
  if (parentId === undefined) return;
  const live = getSession(parentId);
  if (live === undefined) return;
  const terminalState = terminalNotificationState(status);
  const key = `${parentId}:${root}:${terminalState}`;
  if (deliveredCompletionKeys.has(key)) return;
  const content = formatCompletionContent(result, status, terminalState);
  if (hasDeliveredCompletionMessage(live.session.messages, root, terminalState, content)) {
    deliveredCompletionKeys.add(key);
    return;
  }
  deliveredCompletionKeys.add(key);
  await live.session.sendCustomMessage(
    {
      customType: "subagent-notify",
      content,
      display: true,
      details: { source: "pi-subagents", runId: root, state: terminalState },
    },
    { triggerTurn: true },
  );
}

export async function deliverExternalSubagentSessionListChange(root: string): Promise<void> {
  const status = await readStatusByRoot(root);
  if (status === undefined) return;
  const parentId = await sessionIdFromSessionReference(status.parentSessionId);
  if (parentId === undefined) return;
  const live = getSession(parentId);
  if (live === undefined) return;
  const key = `${parentId}:${root}:${status.state}`;
  if (deliveredSessionListKeys.has(key)) return;
  deliveredSessionListKeys.add(key);
  for (const c of live.clients) {
    c.send({
      type: "session_list_changed",
      sessionId: parentId,
      projectId: live.projectId,
      reason: `subagent_async_${status.state}`,
    });
  }
}

async function scanSubagentRuns(): Promise<void> {
  let entries: string[];
  try {
    entries = await readdir(SUBAGENTS_ASYNC_DIR);
  } catch {
    return;
  }
  await Promise.all(
    entries.map(async (root) => {
      await deliverExternalSubagentSessionListChange(root);
      await deliverExternalSubagentCompletionForRun(root);
    }),
  );
}

export function startExternalSubagentsWatcher(): void {
  if (watcherStarted) return;
  watcherStarted = true;
  void scanSubagentRuns();
  scanTimer = setInterval(() => void scanSubagentRuns(), 3000);
  scanTimer.unref?.();
  try {
    asyncWatcher = watch(SUBAGENTS_ASYNC_DIR, () => void scanSubagentRuns());
    asyncWatcher.unref?.();
  } catch {
    // Directory may not exist until pi-subagents first runs. Explicit checks in routes still work.
  }
  try {
    resultsWatcher = watch(SUBAGENTS_RESULTS_DIR, () => void scanSubagentRuns());
    resultsWatcher.unref?.();
  } catch {
    // Result files are optional and may be consumed by pi-subagents itself.
  }
}

export function stopExternalSubagentsWatcher(): void {
  asyncWatcher?.close();
  resultsWatcher?.close();
  if (scanTimer !== undefined) clearInterval(scanTimer);
  asyncWatcher = undefined;
  resultsWatcher = undefined;
  scanTimer = undefined;
  watcherStarted = false;
}
