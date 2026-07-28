import { existsSync, readFileSync, watch, type FSWatcher } from "node:fs";
import {
  link,
  lstat,
  mkdir,
  open,
  readdir,
  readFile,
  rename,
  stat,
  unlink,
  writeFile,
} from "node:fs/promises";
import { randomUUID } from "node:crypto";
import { join, relative, resolve } from "node:path";
import * as os from "node:os";
import { SessionManager } from "@earendil-works/pi-coding-agent";
import type { AgentMessage } from "@earendil-works/pi-agent-core";
import { getSession } from "./session-registry.js";
import { config } from "./config.js";
import { makeLock } from "./concurrency.js";

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

export type ExternalSubagentSteeringState =
  | "queued"
  | "scheduled"
  | "routed"
  | "delivered"
  | "late"
  | "failed"
  | "recovered";

export interface ExternalSubagentFleetSteerTarget {
  index: number;
  state: ExternalSubagentSteeringState;
  updatedAt?: number;
  reason?: string;
}

export interface ExternalSubagentFleetSteer {
  requestId: string;
  submittedAt: number;
  messagePreview: string;
  targets: ExternalSubagentFleetSteerTarget[];
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
  steering: ExternalSubagentFleetSteer[];
  children: ExternalSubagentFleetChild[];
}

interface AsyncStatusStep {
  agent?: string;
  status?: string;
  success?: boolean;
  exitCode?: number;
  model?: string;
  sessionFile?: string;
  startedAt?: number;
  endedAt?: number;
  durationMs?: number;
  error?: string;
}

interface AsyncSteeringTarget {
  index?: number;
  state?: ExternalSubagentSteeringState;
  routedAt?: number;
  deliveredAt?: number;
  lateDeliveredAt?: number;
  failedAt?: number;
  recoveredAt?: number;
  reason?: string;
}

interface AsyncSteeringRequest {
  id?: string;
  requestedAt?: number;
  messagePreview?: string;
  targets?: AsyncSteeringTarget[];
}

interface AsyncSteeringStatus {
  recent?: AsyncSteeringRequest[];
}

interface AsyncSteerRequestFile {
  type?: string;
  id?: string;
  ts?: number;
  message?: string;
  targetIndex?: number;
  targetIndexes?: number[];
  source?: string;
}

interface AsyncStatusFile {
  runId?: string;
  sessionId?: string;
  mode?: string;
  state?: ExternalSubagentState;
  success?: boolean;
  exitCode?: number;
  sessionFile?: string;
  startedAt?: number;
  endedAt?: number;
  lastActivityAt?: number;
  lastUpdate?: number;
  durationMs?: number;
  error?: string;
  steering?: AsyncSteeringStatus;
  steps?: AsyncStatusStep[];
}

interface AsyncResult {
  agent?: string;
  output?: string;
  finalOutput?: string;
  success?: boolean;
  exitCode?: number;
  error?: string;
  sessionFile?: string;
}

interface AsyncResultFile {
  id?: string;
  runId?: string;
  agent?: string;
  success?: boolean;
  exitCode?: number;
  error?: string;
  summary?: string;
  state?: string;
  sessionId?: string;
  sessionFile?: string;
  results?: AsyncResult[];
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
/** pi-subagents 0.37 native supervisor request/reply filesystem channel. */
export const SUBAGENTS_SUPERVISOR_CHANNEL_DIR = join(SUBAGENTS_TEMP_ROOT, "supervisor-channels");

export type ExternalSupervisorRequestStatus = "open" | "answered" | "cancelled" | "expired";
export type ExternalSupervisorRequestReason =
  | "need_decision"
  | "interview_request"
  | "progress_update";

/** A sanitized, correlated projection of pi-subagents' native supervisor channel. */
export interface ExternalSupervisorRequest {
  requestId: string;
  parentSessionId: string;
  runId: string;
  agent: string;
  childIndex: number;
  reason: ExternalSupervisorRequestReason;
  expectsReply: boolean;
  createdAt: number;
  expiresAt?: number;
  message: string;
  interview?: unknown;
  status: ExternalSupervisorRequestStatus;
  repliedAt?: number;
}

interface SupervisorRequestFile {
  type?: unknown;
  id?: unknown;
  createdAt?: unknown;
  expiresAt?: unknown;
  reason?: unknown;
  message?: unknown;
  expectsReply?: unknown;
  orchestratorSessionId?: unknown;
  runId?: unknown;
  agent?: unknown;
  childIndex?: unknown;
  interview?: unknown;
}

interface SupervisorReplyFile {
  type?: unknown;
  requestId?: unknown;
  createdAt?: unknown;
  message?: unknown;
}

interface SupervisorRequestRecord extends ExternalSupervisorRequest {
  channelDir: string;
}

const SUPERVISOR_HISTORY_PATH = join(config.forgeDataDir, "subagent-supervisor-requests.json");
const MAX_SUPERVISOR_HISTORY = 500;
const supervisorRequestLock = makeLock();

function isSafeSupervisorId(value: unknown): value is string {
  return typeof value === "string" && /^[A-Za-z0-9._-]{1,256}$/.test(value);
}

function safeSupervisorString(value: unknown, maxLength: number): string | undefined {
  if (typeof value !== "string") return undefined;
  const trimmed = value.trim();
  if (!trimmed || Buffer.byteLength(trimmed, "utf8") > maxLength) return undefined;
  return trimmed;
}

function finiteTimestamp(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) && value >= 0 ? value : undefined;
}

function withinSupervisorRoot(path: string): boolean {
  const rel = relative(resolve(SUBAGENTS_SUPERVISOR_CHANNEL_DIR), resolve(path));
  return rel !== "" && !rel.startsWith("..") && !rel.includes("\\");
}

function parseSupervisorRequest(
  file: string,
  channelDir: string,
): SupervisorRequestRecord | undefined {
  if (!withinSupervisorRoot(channelDir)) return undefined;
  try {
    const parsed = JSON.parse(readFileSync(file, "utf8")) as SupervisorRequestFile;
    const requestId = isSafeSupervisorId(parsed.id) ? parsed.id : undefined;
    const parentSessionId = safeSupervisorString(parsed.orchestratorSessionId, 256);
    const runId = safeSupervisorString(parsed.runId, 4096);
    const agent = safeSupervisorString(parsed.agent, 256);
    const message = safeSupervisorString(parsed.message, 64 * 1024);
    const createdAt = finiteTimestamp(parsed.createdAt);
    const reason = parsed.reason;
    if (
      requestId === undefined ||
      parentSessionId === undefined ||
      runId === undefined ||
      agent === undefined ||
      message === undefined ||
      createdAt === undefined ||
      typeof parsed.childIndex !== "number" ||
      !Number.isInteger(parsed.childIndex) ||
      (reason !== "need_decision" &&
        reason !== "interview_request" &&
        reason !== "progress_update") ||
      typeof parsed.expectsReply !== "boolean"
    )
      return undefined;
    const expiresAt = finiteTimestamp(parsed.expiresAt);
    return {
      requestId,
      parentSessionId,
      runId,
      agent,
      childIndex: parsed.childIndex,
      reason,
      expectsReply: parsed.expectsReply,
      createdAt,
      ...(expiresAt === undefined ? {} : { expiresAt }),
      message,
      ...(parsed.interview === undefined ? {} : { interview: parsed.interview }),
      status: "open",
      channelDir,
    };
  } catch {
    return undefined;
  }
}

async function readSupervisorRequests(): Promise<SupervisorRequestRecord[]> {
  let channels: import("node:fs").Dirent[];
  try {
    channels = await readdir(SUBAGENTS_SUPERVISOR_CHANNEL_DIR, { withFileTypes: true });
  } catch {
    return [];
  }
  const entries = await Promise.all(
    channels
      .filter((entry) => entry.isDirectory() && !entry.isSymbolicLink())
      .map(async (entry) => {
        const channelDir = join(SUBAGENTS_SUPERVISOR_CHANNEL_DIR, entry.name);
        let files: import("node:fs").Dirent[];
        try {
          files = await readdir(join(channelDir, "requests"), { withFileTypes: true });
        } catch {
          return [] as SupervisorRequestRecord[];
        }
        return (
          await Promise.all(
            files
              .filter(
                (file) => file.isFile() && !file.isSymbolicLink() && file.name.endsWith(".json"),
              )
              .map((entry) =>
                readFile(join(channelDir, "requests", entry.name), "utf8")
                  .then(() =>
                    parseSupervisorRequest(join(channelDir, "requests", entry.name), channelDir),
                  )
                  .catch(() => undefined),
              ),
          )
        ).filter((request): request is SupervisorRequestRecord => request !== undefined);
      }),
  );
  const requests = entries.flat();
  const counts = new Map<string, number>();
  for (const request of requests) {
    counts.set(request.requestId, (counts.get(request.requestId) ?? 0) + 1);
  }
  // A request id must identify exactly one channel. Treat duplicate files as
  // malformed rather than risking a reply being routed to the wrong child.
  return requests.filter((request) => counts.get(request.requestId) === 1);
}

async function readSupervisorHistory(): Promise<ExternalSupervisorRequest[]> {
  const parsed = await readJson<{ requests?: unknown }>(SUPERVISOR_HISTORY_PATH);
  if (!Array.isArray(parsed?.requests)) return [];
  return parsed.requests.filter((request): request is ExternalSupervisorRequest => {
    if (!request || typeof request !== "object") return false;
    const value = request as Partial<ExternalSupervisorRequest>;
    return (
      isSafeSupervisorId(value.requestId) &&
      typeof value.parentSessionId === "string" &&
      typeof value.runId === "string" &&
      typeof value.agent === "string" &&
      typeof value.childIndex === "number" &&
      Number.isInteger(value.childIndex) &&
      (value.reason === "need_decision" ||
        value.reason === "interview_request" ||
        value.reason === "progress_update") &&
      typeof value.expectsReply === "boolean" &&
      typeof value.createdAt === "number" &&
      typeof value.message === "string" &&
      (value.status === "open" ||
        value.status === "answered" ||
        value.status === "cancelled" ||
        value.status === "expired")
    );
  });
}

async function writeSupervisorHistory(requests: ExternalSupervisorRequest[]): Promise<void> {
  await mkdir(config.forgeDataDir, { recursive: true });
  const temporary = `${SUPERVISOR_HISTORY_PATH}.${randomUUID()}.tmp`;
  await writeFile(
    temporary,
    JSON.stringify({ requests: requests.slice(0, MAX_SUPERVISOR_HISTORY) }),
    { encoding: "utf8", mode: 0o600 },
  );
  await rename(temporary, SUPERVISOR_HISTORY_PATH);
}

function replyFileFor(request: SupervisorRequestRecord): string {
  return join(request.channelDir, "replies", `${request.requestId}.json`);
}

async function readSupervisorReply(
  path: string,
  requestId: string,
): Promise<SupervisorReplyFile | undefined> {
  const parsed = await readJson<SupervisorReplyFile>(path);
  return parsed?.type === "subagent.supervisor.reply" &&
    parsed.requestId === requestId &&
    typeof parsed.message === "string"
    ? parsed
    : undefined;
}

function supervisorStatus(
  request: SupervisorRequestRecord,
  reply: SupervisorReplyFile | undefined,
  now: number,
): ExternalSupervisorRequestStatus {
  if (reply !== undefined) return "answered";
  return request.expiresAt !== undefined && now > request.expiresAt ? "expired" : "open";
}

function publicSupervisorRequest(
  record: SupervisorRequestRecord | ExternalSupervisorRequest,
): ExternalSupervisorRequest {
  const { channelDir: _channelDir, ...request } = record as SupervisorRequestRecord;
  return request;
}

export type ExternalSupervisorReplyResult =
  | { accepted: true; status: "answered" | "cancelled"; repliedAt: number }
  | {
      accepted: false;
      code:
        | "request_not_found"
        | "request_not_open"
        | "request_expired"
        | "request_already_answered";
      message: string;
    };

/**
 * List and durably project requests from pi-subagents 0.37's native channel.
 * Only requests with the exact orchestrator session, run, and request id are
 * exposed; malformed or cross-channel files are ignored.
 */
export async function listExternalSupervisorRequests(): Promise<ExternalSupervisorRequest[]> {
  return supervisorRequestLock(async () => {
    const now = Date.now();
    const history = await readSupervisorHistory();
    const byId = new Map(history.map((request) => [request.requestId, request]));
    const live = await readSupervisorRequests();
    for (const request of live) {
      if (!request.expectsReply) continue;
      const reply = await readSupervisorReply(replyFileFor(request), request.requestId);
      const prior = byId.get(request.requestId);
      const status =
        prior?.status === "cancelled" ? "cancelled" : supervisorStatus(request, reply, now);
      const replyCreatedAt = reply === undefined ? undefined : finiteTimestamp(reply.createdAt);
      byId.set(request.requestId, {
        ...publicSupervisorRequest(request),
        status,
        ...(replyCreatedAt !== undefined
          ? { repliedAt: replyCreatedAt }
          : prior?.repliedAt === undefined
            ? {}
            : { repliedAt: prior.repliedAt }),
      });
    }
    const projected = [...byId.values()]
      .filter(
        (request) =>
          request.status !== "open" ||
          live.some((liveRequest) => liveRequest.requestId === request.requestId),
      )
      .sort((a, b) => b.createdAt - a.createdAt || a.requestId.localeCompare(b.requestId));
    await writeSupervisorHistory(projected);
    return projected.map(publicSupervisorRequest);
  });
}

/**
 * Atomically reply to one exact native request. `link()` makes a concurrent
 * browser/terminal reply fail rather than replacing the first reply file.
 */
export async function replyExternalSupervisorRequest(
  requestId: string,
  message: string,
  declined = false,
): Promise<ExternalSupervisorReplyResult> {
  return supervisorRequestLock(async () => {
    if (!isSafeSupervisorId(requestId)) {
      return {
        accepted: false,
        code: "request_not_found",
        message: "The supervisor request was not found.",
      };
    }
    const normalized = message.trim();
    if (!normalized || Buffer.byteLength(normalized, "utf8") > 64 * 1024) {
      return {
        accepted: false,
        code: "request_not_open",
        message: "A supervisor reply must contain at most 64 KiB of text.",
      };
    }
    const request = (await readSupervisorRequests()).find(
      (candidate) => candidate.requestId === requestId && candidate.expectsReply,
    );
    if (request === undefined) {
      return {
        accepted: false,
        code: "request_not_found",
        message: "The supervisor request is no longer open.",
      };
    }
    const replyPath = replyFileFor(request);
    if ((await readSupervisorReply(replyPath, requestId)) !== undefined) {
      return {
        accepted: false,
        code: "request_already_answered",
        message: "This supervisor request already has a reply.",
      };
    }
    if (request.expiresAt !== undefined && Date.now() > request.expiresAt) {
      return {
        accepted: false,
        code: "request_expired",
        message: "This supervisor request has expired.",
      };
    }
    const repliedAt = Date.now();
    const temporary = join(request.channelDir, "replies", `.${requestId}.${randomUUID()}.tmp`);
    const reply = {
      type: "subagent.supervisor.reply",
      requestId,
      createdAt: repliedAt,
      message: normalized,
    };
    try {
      const repliesDir = join(request.channelDir, "replies");
      await mkdir(repliesDir, { recursive: true, mode: 0o700 });
      const repliesInfo = await lstat(repliesDir);
      if (!repliesInfo.isDirectory() || repliesInfo.isSymbolicLink()) {
        return {
          accepted: false,
          code: "request_not_open",
          message: "The native supervisor reply channel is unavailable.",
        };
      }
      await writeFile(temporary, JSON.stringify(reply), { encoding: "utf8", mode: 0o600 });
      await link(temporary, replyPath);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "EEXIST") {
        return {
          accepted: false,
          code: "request_already_answered",
          message: "This supervisor request already has a reply.",
        };
      }
      return {
        accepted: false,
        code: "request_not_open",
        message: "The native supervisor reply channel is unavailable.",
      };
    } finally {
      await unlink(temporary).catch(() => undefined);
    }
    const history = await readSupervisorHistory();
    const status = declined ? ("cancelled" as const) : ("answered" as const);
    const projected: ExternalSupervisorRequest = {
      ...publicSupervisorRequest(request),
      status,
      repliedAt,
    };
    const retained = history.filter((record) => record.requestId !== requestId);
    retained.push(projected);
    await writeSupervisorHistory(retained);
    return { accepted: true, status, repliedAt };
  });
}

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
const MAX_FLEET_RUN_CACHE_ENTRIES = 500;
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
  const result = existsSync(resultPath) ? await readJson<AsyncResultFile>(resultPath) : undefined;
  const state = projectedState(
    status.state,
    hasFailedResult(status) || status.steps?.some((step) => hasFailedResult(step))
      ? { success: false }
      : result,
  );
  const out: ExternalSubagentStatus = {
    runId: status.runId ?? root,
    rootRunId: root,
    state,
    isExternalLive: ACTIVE_STATES.has(state),
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

/** Preserve identity verbatim; display consumers are responsible for truncation. */
function stableRunId(value: unknown): string | undefined {
  if (typeof value !== "string" || value.trim().length === 0) return undefined;
  return value;
}

interface AsyncOutcome {
  success?: boolean;
  exitCode?: number;
}

function hasFailedResult(result: AsyncOutcome | undefined): boolean {
  return (
    result?.success === false ||
    (typeof result?.exitCode === "number" &&
      Number.isFinite(result.exitCode) &&
      result.exitCode !== 0)
  );
}

function statusStepsHaveFailure(steps: AsyncStatusStep[] | undefined): boolean {
  return steps?.some((step) => hasFailedResult(step)) === true;
}

function resultFailureError(
  result: AsyncResult | AsyncResultFile | AsyncStatusStep | undefined,
): string | undefined {
  const error = nonEmptyString(result?.error);
  if (error !== undefined) return error;
  if (
    typeof result?.exitCode === "number" &&
    Number.isFinite(result.exitCode) &&
    result.exitCode !== 0
  ) {
    return `Subagent exited with code ${result.exitCode}`;
  }
  return result?.success === false ? "Subagent reported failure" : undefined;
}

/** A completed launcher can still contain a failed child process result. */
function projectedState(
  statusState: ExternalSubagentState,
  result: AsyncOutcome | undefined,
): ExternalSubagentState {
  return statusState === "complete" && hasFailedResult(result) ? "failed" : statusState;
}

function validSteeringState(value: unknown): value is ExternalSubagentSteeringState {
  return (
    value === "queued" ||
    value === "scheduled" ||
    value === "routed" ||
    value === "delivered" ||
    value === "late" ||
    value === "failed" ||
    value === "recovered"
  );
}

function steeringTargetFrom(
  value: AsyncSteeringTarget,
): ExternalSubagentFleetSteerTarget | undefined {
  const index = value.index;
  if (
    typeof index !== "number" ||
    !Number.isInteger(index) ||
    index < 0 ||
    !validSteeringState(value.state)
  ) {
    return undefined;
  }
  const target: ExternalSubagentFleetSteerTarget = { index, state: value.state };
  const stateTimestamp = {
    queued: undefined,
    scheduled: undefined,
    routed: value.routedAt,
    delivered: value.deliveredAt,
    late: value.lateDeliveredAt,
    failed: value.failedAt,
    recovered: value.recoveredAt,
  }[value.state];
  const updatedAt = finiteNonNegative(
    stateTimestamp ??
      value.routedAt ??
      value.deliveredAt ??
      value.lateDeliveredAt ??
      value.failedAt ??
      value.recoveredAt,
  );
  const reason = nonEmptyString(value.reason);
  if (updatedAt !== undefined) target.updatedAt = updatedAt;
  if (reason !== undefined) target.reason = reason;
  return target;
}

function steeringFromStatus(status: AsyncStatusFile): ExternalSubagentFleetSteer[] {
  if (!Array.isArray(status.steering?.recent)) return [];
  return status.steering.recent.flatMap((request) => {
    const requestId = nonEmptyString(request.id, 256);
    const submittedAt = finiteNonNegative(request.requestedAt);
    const messagePreview = nonEmptyString(request.messagePreview, 160);
    const targets = Array.isArray(request.targets)
      ? request.targets.flatMap((target) => {
          const projected = steeringTargetFrom(target);
          return projected === undefined ? [] : [projected];
        })
      : [];
    if (requestId === undefined || submittedAt === undefined || messagePreview === undefined)
      return [];
    return [{ requestId, submittedAt, messagePreview, targets }];
  });
}

async function queuedSteeringFromControl(
  asyncDir: string,
  knownRequestIds: ReadonlySet<string>,
): Promise<ExternalSubagentFleetSteer[]> {
  const requestDir = join(asyncDir, "control", "steer-requests");
  let entries: string[];
  try {
    entries = await readdir(requestDir);
  } catch {
    return [];
  }
  const queued = await Promise.all(
    entries
      .filter((entry) => entry.endsWith(".json"))
      .map(async (entry) => readJson<AsyncSteerRequestFile>(join(requestDir, entry))),
  );
  return queued.flatMap((request) => {
    const requestId = nonEmptyString(request?.id, 256);
    const submittedAt = finiteNonNegative(request?.ts);
    const message = nonEmptyString(request?.message, 128 * 1024);
    if (
      request?.type !== "steer" ||
      requestId === undefined ||
      submittedAt === undefined ||
      message === undefined ||
      knownRequestIds.has(requestId)
    ) {
      return [];
    }
    const targetIndexes =
      Number.isInteger(request.targetIndex) && request.targetIndex! >= 0
        ? [request.targetIndex!]
        : Array.isArray(request.targetIndexes)
          ? request.targetIndexes.filter(
              (index): index is number => Number.isInteger(index) && index >= 0,
            )
          : [];
    return [
      {
        requestId,
        submittedAt,
        messagePreview: message.slice(0, 160),
        targets: targetIndexes.map((index) => ({ index, state: "queued" as const })),
      },
    ];
  });
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
  steerRequestsPath: string,
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
    let steerRequestsStamp = "missing";
    try {
      const steerRequestsInfo = await stat(steerRequestsPath);
      steerRequestsStamp = `${steerRequestsInfo.mtimeMs}:${steerRequestsInfo.size}`;
    } catch {
      // The control inbox does not exist until a live runner initializes it.
    }
    return `${statusInfo.mtimeMs}:${statusInfo.size}:${resultStamp}:${steerRequestsStamp}`;
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
  const statusState = isExternalState(step?.status) ? step.status : runState;
  const state = projectedState(projectedState(statusState, step), result);
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
  const error = nonEmptyString(
    step?.error ?? resultFailureError(step) ?? resultFailureError(result),
  );
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

function boundFleetRunCache(): void {
  while (fleetRunCache.size > MAX_FLEET_RUN_CACHE_ENTRIES) {
    const oldestRoot = fleetRunCache.keys().next().value;
    if (oldestRoot === undefined) return;
    fleetRunCache.delete(oldestRoot);
  }
}

function pruneFleetRunCache(roots: ReadonlySet<string>): void {
  for (const root of fleetRunCache.keys()) {
    if (!roots.has(root)) fleetRunCache.delete(root);
  }
  boundFleetRunCache();
}

function cacheFleetRun(
  root: string,
  value: { stamp: string; run: ExternalSubagentFleetRun },
): void {
  // Refresh insertion order so the bounded cache evicts least-recently-used runs.
  fleetRunCache.delete(root);
  fleetRunCache.set(root, value);
  boundFleetRunCache();
}

async function readFleetRun(
  root: string,
  forceRefresh = false,
): Promise<ExternalSubagentFleetRun | undefined> {
  const statusPath = join(SUBAGENTS_ASYNC_DIR, root, "status.json");
  const resultPath = join(SUBAGENTS_RESULTS_DIR, `${root}.json`);
  const stamp = await fleetCacheStamp(
    statusPath,
    resultPath,
    join(SUBAGENTS_ASYNC_DIR, root, "control", "steer-requests"),
  );
  if (stamp === undefined) return undefined;
  const cached = fleetRunCache.get(root);
  if (
    !forceRefresh &&
    cached?.stamp === stamp &&
    cached.run.parentSessionId !== undefined &&
    cached.run.children.every((child) => child.sessionId !== undefined)
  ) {
    cacheFleetRun(root, cached);
    return cached.run;
  }

  const status = await readJson<AsyncStatusFile>(statusPath);
  if (!isExternalState(status?.state)) return undefined;
  const runId = stableRunId(status.runId) ?? root;
  const parentSessionId = await sessionIdFromSessionReference(status.sessionId);
  const result = await readJson<AsyncResultFile>(resultPath);
  const runState = projectedState(
    status.state,
    hasFailedResult(status) || statusStepsHaveFailure(status.steps) ? { success: false } : result,
  );
  const statusSteps = Array.isArray(status.steps) ? status.steps : [];
  const resultSteps = Array.isArray(result?.results) ? result.results : [];
  const childCount = Math.max(statusSteps.length, resultSteps.length);
  const children = await Promise.all(
    Array.from({ length: childCount }, (_, index) =>
      fleetChildFrom(runId, index, runState, statusSteps[index], resultSteps[index]),
    ),
  );
  const startedAt = finiteNonNegative(status.startedAt);
  const endedAt = finiteNonNegative(status.endedAt);
  const steeringFromLifecycle = steeringFromStatus(status);
  const queuedSteering = await queuedSteeringFromControl(
    join(SUBAGENTS_ASYNC_DIR, root),
    new Set(steeringFromLifecycle.map((request) => request.requestId)),
  );
  const steering = [...steeringFromLifecycle, ...queuedSteering].sort(
    (a, b) => b.submittedAt - a.submittedAt || a.requestId.localeCompare(b.requestId),
  );
  const run: ExternalSubagentFleetRun = { runId, state: runState, steering, children };
  const mode = nonEmptyString(status.mode, 100);
  const error =
    nonEmptyString(status.error) ??
    children.find((child) => child.error !== undefined)?.error ??
    resultFailureError(result);
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
  cacheFleetRun(root, { stamp, run });
  return run;
}

export type ExternalSubagentSteerResult =
  | { accepted: true; requestId: string; submittedAt: number }
  | { accepted: false; code: "run_not_found" | "run_not_steerable" | "run_stale"; message: string };

export type ExternalSubagentStopResult =
  | { accepted: true; requestedAt: number }
  | { accepted: false; code: "run_not_found" | "run_not_stoppable" | "run_stale"; message: string };

/**
 * Queue a steer using pi-subagents 0.37's file control protocol. A successful
 * result only confirms the request was atomically queued for its runner; the
 * Fleet projection later exposes the runner/Pi delivery acknowledgment.
 */
export async function queueExternalSubagentSteer(
  runId: string,
  message: string,
): Promise<ExternalSubagentSteerResult> {
  const normalizedRunId = runId.trim();
  const normalizedMessage = message.trim();
  if (!normalizedRunId) {
    return { accepted: false, code: "run_not_found", message: "The subagent run was not found." };
  }
  if (!normalizedMessage) {
    return {
      accepted: false,
      code: "run_not_steerable",
      message: "Steering text must not be empty.",
    };
  }
  if (Buffer.byteLength(normalizedMessage, "utf8") > 128 * 1024) {
    return {
      accepted: false,
      code: "run_not_steerable",
      message: "Steering text exceeds the pi-subagents 128 KiB control-channel limit.",
    };
  }

  for (const root of await readStatusRoots()) {
    const asyncDir = join(SUBAGENTS_ASYNC_DIR, root);
    const status = await readJson<AsyncStatusFile>(join(asyncDir, "status.json"));
    if ((stableRunId(status?.runId) ?? root) !== normalizedRunId) continue;
    if (status?.state !== "running") {
      return {
        accepted: false,
        code: "run_not_steerable",
        message: `Run ${normalizedRunId} is ${status?.state ?? "not active"}; only running runs can receive live steering.`,
      };
    }
    if (existsSync(join(asyncDir, "control", "steer-inbox-closed.json"))) {
      return {
        accepted: false,
        code: "run_stale",
        message: `Run ${normalizedRunId} stopped accepting steering. Refresh Fleet and start a new run if it has ended.`,
      };
    }
    const targetIndexes = (status.steps ?? [])
      .map((step, index) => (step.status === "running" ? index : undefined))
      .filter((index): index is number => index !== undefined);
    if (targetIndexes.length === 0) {
      return {
        accepted: false,
        code: "run_stale",
        message: `Run ${normalizedRunId} has no running child to receive steering. Refresh Fleet before trying again.`,
      };
    }

    const requestId = randomUUID();
    const submittedAt = Date.now();
    const request = {
      type: "steer",
      id: requestId,
      ts: submittedAt,
      message: normalizedMessage,
      targetIndexes,
      source: "pi-forge",
    };
    const requestDir = join(asyncDir, "control", "steer-requests");
    const name = `${String(submittedAt).padStart(13, "0")}-${Buffer.from(requestId).toString("base64url")}.json`;
    const target = join(requestDir, name);
    const temporary = join(requestDir, `.${name}.${randomUUID()}.tmp`);
    try {
      await mkdir(requestDir, { recursive: true });
      await writeFile(temporary, JSON.stringify(request), { encoding: "utf8", mode: 0o600 });
      await rename(temporary, target);
      // The runner can consume the request immediately after rename. Do not
      // retract a committed request when its inbox closes concurrently: doing
      // so could report rejection even though Pi already accepted the input.
      return { accepted: true, requestId, submittedAt };
    } catch {
      await unlink(temporary).catch(() => undefined);
      return {
        accepted: false,
        code: "run_stale",
        message: `The control channel for run ${normalizedRunId} is unavailable. Refresh Fleet and verify the run is still active.`,
      };
    }
  }
  return {
    accepted: false,
    code: "run_not_found",
    message: `Run ${normalizedRunId} was not found.`,
  };
}

/**
 * Request an irreversible stop using pi-subagents 0.37's file control protocol.
 * Only an exact, currently running top-level async run is stoppable; an existing
 * request is retained so concurrent callers cannot replace or duplicate it.
 */
export async function queueExternalSubagentStop(
  runId: string,
): Promise<ExternalSubagentStopResult> {
  const normalizedRunId = runId.trim();
  if (!normalizedRunId) {
    return { accepted: false, code: "run_not_found", message: "The subagent run was not found." };
  }

  for (const root of await readStatusRoots()) {
    const asyncDir = join(SUBAGENTS_ASYNC_DIR, root);
    const status = await readJson<AsyncStatusFile>(join(asyncDir, "status.json"));
    if ((stableRunId(status?.runId) ?? root) !== normalizedRunId) continue;
    if (status?.state !== "running") {
      return {
        accepted: false,
        code: "run_not_stoppable",
        message: `Run ${normalizedRunId} is ${status?.state ?? "not active"}; only running runs can be stopped.`,
      };
    }

    const requestedAt = Date.now();
    const request = {
      type: "stop",
      ts: requestedAt,
      source: "pi-forge",
      reason: "Stopped from Fleet",
    };
    try {
      await mkdir(join(asyncDir, "control"), { recursive: true });
      // `wx` exclusively creates the singleton request. The runner consumes
      // stop requests by their presence, so a second caller cannot overwrite it.
      await writeFile(join(asyncDir, "control", "stop.json"), JSON.stringify(request), {
        encoding: "utf8",
        mode: 0o600,
        flag: "wx",
      });
      return { accepted: true, requestedAt };
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === "EEXIST") {
        return {
          accepted: false,
          code: "run_stale",
          message: `A stop request is already pending for run ${normalizedRunId}. Refresh Fleet for its final status.`,
        };
      }
      return {
        accepted: false,
        code: "run_stale",
        message: `The control channel for run ${normalizedRunId} is unavailable. Refresh Fleet and verify the run is still running.`,
      };
    }
  }
  return {
    accepted: false,
    code: "run_not_found",
    message: `Run ${normalizedRunId} was not found.`,
  };
}

/**
 * Read the pi-subagents lifecycle artifacts directly and return a sanitized,
 * stable-id fleet projection. Both active and terminal runs are retained;
 * malformed or partially-written status files are skipped until the next poll.
 */
export async function listExternalSubagentFleetRuns(
  forceRefresh = false,
): Promise<ExternalSubagentFleetRun[]> {
  const roots = await readStatusRoots();
  // Lifecycle directories can be deleted by pi-subagents. Remove their
  // projections before every poll so the process does not retain stale runs.
  pruneFleetRunCache(new Set(roots));
  const runs = (
    await Promise.all(roots.map(async (root) => readFleetRun(root, forceRefresh)))
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

/** Test-only cache visibility for lifecycle-root pruning regression coverage. */
export function _hasExternalSubagentFleetRunCacheEntryForTests(root: string): boolean {
  return fleetRunCache.has(root);
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
