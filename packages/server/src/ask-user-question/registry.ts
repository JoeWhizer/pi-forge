import { randomUUID } from "node:crypto";
import type { AskUserQuestionPresentation, AskUserQuestionResult, Question } from "./types.js";

/**
 * In-memory registry of `ask_user_question` requests waiting on a
 * browser answer. The tool factory registers a pending entry, the
 * answer route resolves it, and the SSE bridge re-emits open
 * entries on snapshot so reconnect resurfaces the modal.
 *
 * Single-process state — pi-forge is single-tenant by design, no
 * cross-process synchronisation needed. The Map is keyed by
 * requestId (uuid). A secondary index by sessionId keeps the
 * "list pending for this session" lookup O(1).
 */

export interface PendingAskUserQuestion {
  requestId: string;
  sessionId: string;
  questions: Question[];
  presentation?: AskUserQuestionPresentation;
  createdAt: Date;
}

interface Entry extends PendingAskUserQuestion {
  resolve: (result: AskUserQuestionResult) => void;
  reject: (error: Error) => void;
  cleanup: () => void;
}

const byRequestId = new Map<string, Entry>();
const bySessionId = new Map<string, Set<string>>();

/**
 * Listener fanout. SSE bridge registers a listener so it can
 * forward `ask_user_question` / `ask_user_question_cancelled`
 * frames to every live client of the affected session.
 *
 * Per-session fanout is implemented at the SSE bridge layer — this
 * module just notifies "something changed for this session, here's
 * what." Keeps the registry decoupled from FastifyReply/socket
 * concerns.
 */
type Listener = (event: AskQuestionEvent) => void;
const listeners = new Set<Listener>();

export type AskQuestionEvent =
  | {
      type: "ask_user_question";
      sessionId: string;
      requestId: string;
      questions: Question[];
      presentation?: AskUserQuestionPresentation;
    }
  | { type: "ask_user_question_cancelled"; sessionId: string; requestId: string; reason: string };

export function subscribe(fn: Listener): () => void {
  listeners.add(fn);
  return () => {
    listeners.delete(fn);
  };
}

function notify(event: AskQuestionEvent): void {
  for (const fn of listeners) {
    try {
      fn(event);
    } catch {
      // listener errors must not break the registry — best-effort fanout
    }
  }
}

/**
 * Register a pending request. The returned promise resolves when
 * the browser answers, when an optional timeout elapses, or when
 * the caller's `signal` aborts. Timeout is intentionally opt-in:
 * normal questionnaires retain their existing unbounded behavior.
 */
export function registerPending(args: {
  sessionId: string;
  questions: Question[];
  presentation?: AskUserQuestionPresentation;
  signal?: AbortSignal;
  timeoutMs?: number;
  timeoutResult?: AskUserQuestionResult;
}): { requestId: string; result: Promise<AskUserQuestionResult> } {
  const requestId = randomUUID();
  let resolveFn!: (r: AskUserQuestionResult) => void;
  let rejectFn!: (err: Error) => void;
  const result = new Promise<AskUserQuestionResult>((resolve, reject) => {
    resolveFn = resolve;
    rejectFn = reject;
  });
  let timeout: ReturnType<typeof setTimeout> | undefined;
  let onAbort: (() => void) | undefined;
  const cleanup = (): void => {
    if (timeout !== undefined) clearTimeout(timeout);
    if (onAbort !== undefined && args.signal !== undefined) {
      args.signal.removeEventListener("abort", onAbort);
    }
  };
  const entry: Entry = {
    requestId,
    sessionId: args.sessionId,
    questions: args.questions,
    ...(args.presentation !== undefined ? { presentation: args.presentation } : {}),
    createdAt: new Date(),
    resolve: resolveFn,
    reject: rejectFn,
    cleanup,
  };
  byRequestId.set(requestId, entry);
  const set = bySessionId.get(args.sessionId) ?? new Set<string>();
  set.add(requestId);
  bySessionId.set(args.sessionId, set);

  if (args.signal !== undefined) {
    onAbort = (): void => {
      if (byRequestId.has(requestId)) {
        removeEntry(requestId);
        notify({
          type: "ask_user_question_cancelled",
          sessionId: args.sessionId,
          requestId,
          reason: "aborted",
        });
        rejectFn(new Error("aborted"));
      }
    };
    if (args.signal.aborted) onAbort();
    else args.signal.addEventListener("abort", onAbort, { once: true });
  }

  // An already-aborted signal rejects synchronously above. Do not create a
  // timer or emit a stale pending event after the entry was removed.
  if (!byRequestId.has(requestId)) return { requestId, result };

  if (args.timeoutMs !== undefined && args.timeoutResult !== undefined) {
    timeout = setTimeout(() => {
      if (!byRequestId.has(requestId)) return;
      removeEntry(requestId);
      notify({
        type: "ask_user_question_cancelled",
        sessionId: args.sessionId,
        requestId,
        reason: "timed_out",
      });
      resolveFn(args.timeoutResult!);
    }, args.timeoutMs);
  }

  notify({
    type: "ask_user_question",
    sessionId: args.sessionId,
    requestId,
    questions: args.questions,
    ...(args.presentation !== undefined ? { presentation: args.presentation } : {}),
  });
  return { requestId, result };
}

function removeEntry(requestId: string): void {
  const e = byRequestId.get(requestId);
  if (e === undefined) return;
  e.cleanup();
  byRequestId.delete(requestId);
  const set = bySessionId.get(e.sessionId);
  if (set !== undefined) {
    set.delete(requestId);
    if (set.size === 0) bySessionId.delete(e.sessionId);
  }
}

/**
 * Resolve the pending entry with the user's answers. Idempotent —
 * if the entry was already resolved (e.g. concurrent answer + abort race), this returns
 * `false` rather than throwing so the route layer can decide whether to 200 or 404.
 */
export function answerPending(
  requestId: string,
  expectedSessionId: string,
  result: AskUserQuestionResult,
): boolean {
  const e = byRequestId.get(requestId);
  if (e === undefined) return false;
  if (e.sessionId !== expectedSessionId) return false;
  removeEntry(requestId);
  notify({
    type: "ask_user_question_cancelled",
    sessionId: e.sessionId,
    requestId,
    reason: "answered",
  });
  e.resolve(result);
  return true;
}

/** Explicit cancel from the client side. */
export function cancelPending(
  requestId: string,
  expectedSessionId: string,
  result: AskUserQuestionResult,
): boolean {
  return answerPending(requestId, expectedSessionId, result);
}

/**
 * Reject and remove every open request for a disposed session. Pending requests
 * are in-memory only, but must not be replayed if the session is resumed.
 */
export function clearForSession(sessionId: string, reason = "session_disposed"): void {
  const ids = [...(bySessionId.get(sessionId) ?? [])];
  for (const requestId of ids) {
    const entry = byRequestId.get(requestId);
    if (entry === undefined) continue;
    removeEntry(requestId);
    notify({
      type: "ask_user_question_cancelled",
      sessionId,
      requestId,
      reason,
    });
    entry.reject(new Error(reason));
  }
}

export function getPendingForSession(sessionId: string): PendingAskUserQuestion[] {
  const ids = bySessionId.get(sessionId);
  if (ids === undefined) return [];
  const out: PendingAskUserQuestion[] = [];
  for (const id of ids) {
    const e = byRequestId.get(id);
    if (e !== undefined) {
      out.push({
        requestId: e.requestId,
        sessionId: e.sessionId,
        questions: e.questions,
        ...(e.presentation !== undefined ? { presentation: e.presentation } : {}),
        createdAt: e.createdAt,
      });
    }
  }
  return out;
}

/** Test-only reset. Clears all pending state without notifying listeners. */
export function _resetForTests(): void {
  for (const entry of byRequestId.values()) entry.cleanup();
  byRequestId.clear();
  bySessionId.clear();
  listeners.clear();
}
