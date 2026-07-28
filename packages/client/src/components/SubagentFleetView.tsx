import { useEffect, useMemo, useRef, useState } from "react";
import {
  CheckCircle2,
  ChevronDown,
  ChevronRight,
  Clock3,
  ExternalLink,
  Loader2,
  PauseCircle,
  RotateCcw,
  Send,
  Square,
  Trash2,
  XCircle,
} from "lucide-react";
import {
  api,
  ApiError,
  type SubagentFleetChild,
  type SubagentFleetRun,
  type SubagentFleetState,
  type SubagentFleetSteeringRequest,
  type SubagentFleetSteeringState,
  type SubagentSupervisorRequest,
} from "../lib/api-client";
import {
  createSubagentFleetNavigationGuard,
  filterCleanedSubagentFleetRuns,
  formatSubagentDuration,
  groupSubagentFleetRuns,
  isActiveSubagentFleetState,
  isCleanableSubagentFleetState,
  isStoppableSubagentFleetRun,
  isSubagentFleetChildSessionDiscovered,
  shouldExpandSubagentFleetRun,
  shouldExpandSubagentFleetRuns,
  truncateSubagentFleetRunId,
} from "../lib/subagent-fleet";
import { useProjectStore } from "../store/project-store";
import { useSessionStore } from "../store/session-store";
import { useSubagentFleetStore } from "../store/subagent-fleet-store";
import { Modal } from "./Modal";

interface Props {
  onClose: () => void;
}

export function SubagentFleetView({ onClose }: Props) {
  const runs = useSubagentFleetStore((state) => state.runs);
  const supervisorRequests = useSubagentFleetStore((state) => state.supervisorRequests);
  const hiddenRunIds = useSubagentFleetStore((state) => state.hiddenRunIds);
  const stoppingRunIds = useSubagentFleetStore((state) => state.stoppingRunIds);
  const expandedParents = useSubagentFleetStore((state) => state.expandedParents);
  const expandedRuns = useSubagentFleetStore((state) => state.expandedRuns);
  const loading = useSubagentFleetStore((state) => state.loading);
  const refreshing = useSubagentFleetStore((state) => state.refreshing);
  const lastRefreshedAt = useSubagentFleetStore((state) => state.lastRefreshedAt);
  const error = useSubagentFleetStore((state) => state.error);
  const load = useSubagentFleetStore((state) => state.load);
  const cleanTerminalRuns = useSubagentFleetStore((state) => state.cleanTerminalRuns);
  const resetCleanedRuns = useSubagentFleetStore((state) => state.resetCleanedRuns);
  const stopRun = useSubagentFleetStore((state) => state.stopRun);
  const toggleParentExpanded = useSubagentFleetStore((state) => state.toggleParentExpanded);
  const toggleRunExpanded = useSubagentFleetStore((state) => state.toggleRunExpanded);
  const startPolling = useSubagentFleetStore((state) => state.startPolling);
  const stopPolling = useSubagentFleetStore((state) => state.stopPolling);
  const projects = useProjectStore((state) => state.projects);
  const sessionsByProject = useSessionStore((state) => state.byProject);
  const loadSessionsForProject = useSessionStore((state) => state.loadSessionsForProject);
  const setActiveSession = useSessionStore((state) => state.setActiveSession);
  const setActiveProject = useProjectStore((state) => state.setActive);
  const [openingSessionId, setOpeningSessionId] = useState<string | undefined>();
  const [openError, setOpenError] = useState<string | undefined>();
  const [stopConfirmationRunId, setStopConfirmationRunId] = useState<string | undefined>();
  const [declineConfirmationRequestId, setDeclineConfirmationRequestId] = useState<
    string | undefined
  >();
  const stopConfirmationRunIdRef = useRef<string | undefined>(undefined);
  stopConfirmationRunIdRef.current = stopConfirmationRunId;
  const declineConfirmationRequest = supervisorRequests.find(
    (request) => request.requestId === declineConfirmationRequestId,
  );
  const stopConfirmationCancelRef = useRef<HTMLButtonElement>(null);
  const stopConfirmationTriggerRef = useRef<HTMLButtonElement>(null);
  const declineConfirmationCancelRef = useRef<HTMLButtonElement>(null);
  const declineConfirmationTriggerRef = useRef<HTMLButtonElement>(null);
  const fleetContentRef = useRef<HTMLDivElement>(null);
  const stopConfirmationDismissalRef = useRef<"cancel" | "confirm" | undefined>(undefined);
  const declineConfirmationDismissalRef = useRef<"cancel" | "confirm" | undefined>(undefined);
  const navigationGuardRef = useRef(createSubagentFleetNavigationGuard());
  const navigationGuard = navigationGuardRef.current;

  useEffect(() => {
    startPolling();
    return stopPolling;
  }, [startPolling, stopPolling]);

  useEffect(() => () => navigationGuard.invalidate(), [navigationGuard]);

  useEffect(() => {
    if (stopConfirmationRunId !== undefined) {
      stopConfirmationCancelRef.current?.focus();
      return;
    }
    if (declineConfirmationRequest !== undefined) {
      declineConfirmationCancelRef.current?.focus();
      return;
    }
    const dismissal =
      stopConfirmationDismissalRef.current ?? declineConfirmationDismissalRef.current;
    if (dismissal === undefined) return;
    const trigger =
      stopConfirmationDismissalRef.current !== undefined
        ? stopConfirmationTriggerRef.current
        : declineConfirmationTriggerRef.current;
    stopConfirmationDismissalRef.current = undefined;
    declineConfirmationDismissalRef.current = undefined;
    if (
      dismissal === "cancel" &&
      trigger !== null &&
      document.contains(trigger) &&
      !trigger.disabled
    ) {
      trigger.focus();
    } else {
      fleetContentRef.current?.focus();
    }
  }, [stopConfirmationRunId, declineConfirmationRequest]);

  // Lifecycle artifacts can precede a child JSONL. Refresh session discovery
  // alongside fleet polling, then only enable navigation for discovered rows.
  useEffect(() => {
    if (lastRefreshedAt === undefined) return;
    for (const project of projects) void loadSessionsForProject(project.id);
  }, [lastRefreshedAt, loadSessionsForProject, projects]);

  const visibleRuns = useMemo(
    () => filterCleanedSubagentFleetRuns(runs, new Set(hiddenRunIds)),
    [hiddenRunIds, runs],
  );
  const groups = useMemo(() => groupSubagentFleetRuns(visibleRuns), [visibleRuns]);
  const sessionsById = useMemo(
    () =>
      new Map(
        Object.values(sessionsByProject)
          .flat()
          .map((session) => [session.sessionId, session] as const),
      ),
    [sessionsByProject],
  );
  const discoveredSessionIds = useMemo(() => new Set(sessionsById.keys()), [sessionsById]);
  const activeCount = visibleRuns.filter((run) => isActiveSubagentFleetState(run.state)).length;

  const closeFleet = (): void => {
    navigationGuard.invalidate();
    onClose();
  };

  const cancelStopConfirmation = (): void => {
    stopConfirmationRunIdRef.current = undefined;
    stopConfirmationDismissalRef.current = "cancel";
    setStopConfirmationRunId(undefined);
  };

  const confirmStop = (): void => {
    const runId = stopConfirmationRunIdRef.current;
    if (runId === undefined) return;
    stopConfirmationRunIdRef.current = undefined;
    stopConfirmationDismissalRef.current = "confirm";
    setStopConfirmationRunId(undefined);
    void stopRun(runId);
  };

  const handleModalClose = (): void => {
    if (stopConfirmationRunIdRef.current !== undefined) {
      cancelStopConfirmation();
      return;
    }
    if (declineConfirmationRequest !== undefined) {
      declineConfirmationDismissalRef.current = "cancel";
      setDeclineConfirmationRequestId(undefined);
      return;
    }
    closeFleet();
  };

  const confirmDecline = (): void => {
    const request = declineConfirmationRequest;
    declineConfirmationDismissalRef.current = "confirm";
    setDeclineConfirmationRequestId(undefined);
    if (request === undefined) return;
    void api.declineSubagentSupervisorRequest(request.requestId).then(
      () => load(true),
      (err: unknown) => {
        const message =
          err instanceof ApiError ? (err.message ?? err.code) : (err as Error).message;
        useSubagentFleetStore.setState({ error: message });
      },
    );
  };

  const openChildSession = (sessionId: string, projectId: string): void => {
    // The button is only enabled for a child returned by session discovery.
    // Avoid probing a not-yet-created id, which used to surface session_not_found.
    const token = navigationGuard.start();
    if (token === undefined) return;
    setOpeningSessionId(sessionId);
    setOpenError(undefined);
    if (!navigationGuard.isCurrent(token)) return;
    setActiveProject(projectId);
    setActiveSession(sessionId);
    navigationGuard.finish(token);
    setOpeningSessionId(undefined);
    closeFleet();
  };

  const reloadedAt =
    lastRefreshedAt === undefined
      ? undefined
      : new Intl.DateTimeFormat(undefined, {
          hour: "2-digit",
          minute: "2-digit",
          second: "2-digit",
        }).format(lastRefreshedAt);

  return [
    <Modal
      key="fleet"
      open
      onClose={handleModalClose}
      title={
        stopConfirmationRunId !== undefined
          ? "Stop subagent"
          : declineConfirmationRequest !== undefined
            ? "Decline supervisor request"
            : "Subagent fleet"
      }
      width="max-w-6xl"
    >
      {stopConfirmationRunId !== undefined && (
        <div role="alert" className="flex flex-col gap-3 px-4 py-3">
          <p id="fleet-stop-confirmation-message" className="text-xs text-neutral-300">
            Stopping this running subagent is permanent. It cannot be resumed; start a new run if
            needed.
          </p>
          <footer className="flex justify-end gap-2 pt-1">
            <button
              ref={stopConfirmationCancelRef}
              type="button"
              onClick={cancelStopConfirmation}
              className="rounded-md border border-neutral-700 px-3 py-1 text-xs text-neutral-200 hover:bg-neutral-800"
            >
              Cancel
            </button>
            <button
              type="button"
              onClick={confirmStop}
              aria-describedby="fleet-stop-confirmation-message"
              className="rounded-md bg-red-700 px-3 py-1 text-xs font-medium text-red-50 hover:bg-red-600"
            >
              Stop run
            </button>
          </footer>
        </div>
      )}
      {declineConfirmationRequest !== undefined && (
        <div role="alert" className="flex flex-col gap-3 px-4 py-3">
          <p className="text-xs text-neutral-300">
            Declining sends a final native reply to {declineConfirmationRequest.agent} for this
            exact request. pi-subagents has no separate cancellation operation.
          </p>
          <footer className="flex justify-end gap-2 pt-1">
            <button
              type="button"
              ref={declineConfirmationCancelRef}
              onClick={() => {
                declineConfirmationDismissalRef.current = "cancel";
                setDeclineConfirmationRequestId(undefined);
              }}
              className="rounded-md border border-neutral-700 px-3 py-1 text-xs text-neutral-200 hover:bg-neutral-800"
            >
              Keep open
            </button>
            <button
              type="button"
              onClick={confirmDecline}
              className="rounded-md bg-red-700 px-3 py-1 text-xs font-medium text-red-50 hover:bg-red-600"
            >
              Decline request
            </button>
          </footer>
        </div>
      )}
      <div
        ref={fleetContentRef}
        hidden={stopConfirmationRunId !== undefined || declineConfirmationRequest !== undefined}
        tabIndex={-1}
        className="flex max-h-[82vh] min-h-64 flex-col overflow-hidden"
      >
        <header className="flex flex-wrap items-center gap-2 border-b border-neutral-800 px-4 py-2 text-xs text-neutral-400 light:border-neutral-200 light:text-neutral-600">
          <span>{activeCount} active</span>
          <span aria-hidden>·</span>
          <span>{visibleRuns.length - activeCount} terminal</span>
          <div className="flex-1" />
          <span className="sr-only" aria-live="polite">
            {refreshing
              ? "Reloading subagent fleet"
              : reloadedAt === undefined
                ? ""
                : `Fleet reloaded at ${reloadedAt}; ${runs.length} runs available.`}
          </span>
          {reloadedAt !== undefined && !refreshing && (
            <span className="text-[10px] text-neutral-500">Updated {reloadedAt}</span>
          )}
          <button
            type="button"
            onClick={() => resetCleanedRuns()}
            disabled={hiddenRunIds.length === 0}
            title="Restore runs hidden by Clean. This does not change server data."
            className="flex items-center gap-1 rounded border border-neutral-700 px-2 py-1 text-neutral-300 hover:border-neutral-500 disabled:opacity-50 light:border-neutral-400 light:text-neutral-700"
          >
            <RotateCcw size={12} />
            Reset
          </button>
          <button
            type="button"
            onClick={() => cleanTerminalRuns()}
            disabled={
              !runs.some(
                (run) =>
                  isCleanableSubagentFleetState(run.state) && !hiddenRunIds.includes(run.runId),
              )
            }
            title="Hide completed, failed, and stopped runs from this Fleet view only. Sessions and artifacts are preserved."
            className="flex items-center gap-1 rounded border border-neutral-700 px-2 py-1 text-neutral-300 hover:border-neutral-500 disabled:opacity-50 light:border-neutral-400 light:text-neutral-700"
          >
            <Trash2 size={12} />
            Clean
          </button>
          <button
            type="button"
            onClick={() => void load(true)}
            disabled={refreshing}
            className="flex items-center gap-1 rounded border border-neutral-700 px-2 py-1 text-neutral-300 hover:border-neutral-500 disabled:opacity-50 light:border-neutral-400 light:text-neutral-700"
          >
            <RotateCcw size={12} className={refreshing ? "animate-spin" : ""} />
            Reload
          </button>
        </header>
        <div className="border-b border-neutral-800 px-4 py-1.5 text-[10px] text-neutral-500 light:border-neutral-200">
          Clean only hides completed, failed, and stopped runs in this Fleet view. Reset restores
          them; neither action changes sessions, artifacts, or server state.
        </div>

        {(error !== undefined || openError !== undefined) && (
          <div className="border-b border-red-800/60 bg-red-950/30 px-4 py-2 text-xs text-red-300 light:border-red-300 light:bg-red-50 light:text-red-800">
            {openError ?? `Could not load fleet: ${error}`}
          </div>
        )}

        <div className="flex-1 overflow-y-auto p-4">
          <SupervisorRequests
            requests={supervisorRequests}
            onSubmitted={() => load(true)}
            onDecline={(requestId, trigger) => {
              declineConfirmationTriggerRef.current = trigger;
              setDeclineConfirmationRequestId(requestId);
            }}
          />
          {loading && visibleRuns.length === 0 ? (
            <div className="flex items-center justify-center gap-2 py-12 text-sm text-neutral-500">
              <Loader2 size={16} className="animate-spin" />
              Loading subagent runs…
            </div>
          ) : groups.length === 0 ? (
            <div className="py-12 text-center text-sm text-neutral-500">
              No pi-subagents lifecycle artifacts found.
            </div>
          ) : (
            <div className="space-y-4">
              {groups.map((group) => {
                const parent =
                  group.parentSessionId === undefined
                    ? undefined
                    : sessionsById.get(group.parentSessionId);
                const parentLabel =
                  parent?.name ??
                  (parent?.firstMessage ? parent.firstMessage.slice(0, 80) : undefined) ??
                  (group.parentSessionId === undefined
                    ? "Parent session unavailable"
                    : `Session ${group.parentSessionId.slice(0, 12)}`);
                const parentKey = `parent:${group.parentSessionId ?? "unresolved"}`;
                const defaultExpanded = shouldExpandSubagentFleetRuns(group.runs);
                const isExpanded = expandedParents[parentKey] ?? defaultExpanded;
                return (
                  <section
                    key={parentKey}
                    className="rounded-lg border border-neutral-800 bg-neutral-950/50 light:border-neutral-200 light:bg-neutral-50"
                  >
                    <header className="border-b border-neutral-800 light:border-neutral-200">
                      <button
                        type="button"
                        onClick={() => toggleParentExpanded(parentKey, defaultExpanded)}
                        aria-expanded={isExpanded}
                        aria-label={
                          isExpanded
                            ? `Collapse parent ${parentLabel}`
                            : `Expand parent ${parentLabel}`
                        }
                        className="flex w-full items-start gap-2 px-3 py-2 text-left hover:bg-neutral-900/50 light:hover:bg-neutral-100"
                      >
                        {isExpanded ? <ChevronDown size={15} /> : <ChevronRight size={15} />}
                        <span className="min-w-0">
                          <span className="block truncate text-sm font-medium text-neutral-100 light:text-neutral-900">
                            {parentLabel}
                          </span>
                          {group.parentSessionId !== undefined && (
                            <span className="block truncate font-mono text-[10px] text-neutral-500">
                              parentSessionId: {group.parentSessionId}
                            </span>
                          )}
                        </span>
                      </button>
                    </header>
                    {isExpanded && (
                      <div className="space-y-2 p-3">
                        {group.runs.map((run) => {
                          const duration = formatSubagentDuration(
                            run.durationMs,
                            run.startedAt,
                            run.endedAt,
                          );
                          const defaultRunExpanded = shouldExpandSubagentFleetRun(run);
                          const isRunExpanded = expandedRuns[run.runId] ?? defaultRunExpanded;
                          return (
                            <article
                              key={run.runId}
                              className="rounded-md border border-neutral-800 bg-neutral-900/70 light:border-neutral-200 light:bg-white"
                            >
                              <div className="flex items-center hover:bg-neutral-800/50 light:hover:bg-neutral-50">
                                <button
                                  type="button"
                                  onClick={() => toggleRunExpanded(run.runId, defaultRunExpanded)}
                                  aria-expanded={isRunExpanded}
                                  aria-label={
                                    isRunExpanded
                                      ? `Collapse run ${run.runId}`
                                      : `Expand run ${run.runId}`
                                  }
                                  className="flex min-w-0 flex-1 flex-wrap items-center gap-2 px-3 py-2 text-left text-xs"
                                >
                                  {isRunExpanded ? (
                                    <ChevronDown size={14} />
                                  ) : (
                                    <ChevronRight size={14} />
                                  )}
                                  <StatusBadge state={run.state} />
                                  <span
                                    title={run.runId}
                                    className="min-w-0 max-w-full break-all font-mono text-neutral-300 light:text-neutral-700"
                                  >
                                    {truncateSubagentFleetRunId(run.runId)}
                                  </span>
                                  {run.mode !== undefined && (
                                    <span className="rounded bg-neutral-800 px-1.5 py-0.5 text-[10px] uppercase text-neutral-400 light:bg-neutral-100 light:text-neutral-600">
                                      {run.mode}
                                    </span>
                                  )}
                                  <span className="flex-1" />
                                  {run.model !== undefined && (
                                    <span className="font-mono text-[11px] text-neutral-400">
                                      {run.model}
                                    </span>
                                  )}
                                  {duration !== undefined && (
                                    <span className="flex items-center gap-1 text-neutral-500">
                                      <Clock3 size={11} /> {duration}
                                    </span>
                                  )}
                                </button>
                                {isStoppableSubagentFleetRun(run) && (
                                  <button
                                    type="button"
                                    onClick={(event) => {
                                      stopConfirmationTriggerRef.current = event.currentTarget;
                                      stopConfirmationRunIdRef.current = run.runId;
                                      setStopConfirmationRunId(run.runId);
                                    }}
                                    disabled={stoppingRunIds.includes(run.runId)}
                                    aria-label={`Stop run ${run.runId}`}
                                    title={
                                      stoppingRunIds.includes(run.runId)
                                        ? "Stop requested; waiting for the runner to finish"
                                        : "Stop this running subagent"
                                    }
                                    className="mr-2 rounded p-1 text-red-300 hover:bg-red-950/60 hover:text-red-100 disabled:cursor-not-allowed disabled:opacity-50 light:text-red-700 light:hover:bg-red-100"
                                  >
                                    {stoppingRunIds.includes(run.runId) ? (
                                      <Loader2 size={13} className="animate-spin" />
                                    ) : (
                                      <Square size={13} />
                                    )}
                                  </button>
                                )}
                              </div>
                              {isRunExpanded && (
                                <>
                                  {run.error !== undefined && (
                                    <div className="border-t border-red-900/50 bg-red-950/20 px-3 py-2 text-xs text-red-300 light:border-red-200 light:bg-red-50 light:text-red-800">
                                      {run.error}
                                    </div>
                                  )}
                                  <FleetSteering run={run} onSubmitted={() => load(true)} />
                                  {run.children.length > 0 && (
                                    <div className="border-t border-neutral-800 px-3 py-2 light:border-neutral-200">
                                      <div className="ml-2 space-y-1 border-l border-neutral-700 pl-3 light:border-neutral-300">
                                        {run.children.map((child, index) => {
                                          const session =
                                            child.sessionId === undefined
                                              ? undefined
                                              : sessionsById.get(child.sessionId);
                                          return (
                                            <ChildRow
                                              key={child.childId}
                                              child={child}
                                              index={index}
                                              opening={openingSessionId !== undefined}
                                              openingThis={openingSessionId === child.sessionId}
                                              sessionProjectId={session?.projectId}
                                              sessionDiscovered={isSubagentFleetChildSessionDiscovered(
                                                child.sessionId,
                                                discoveredSessionIds,
                                              )}
                                              onOpen={openChildSession}
                                            />
                                          );
                                        })}
                                      </div>
                                    </div>
                                  )}
                                </>
                              )}
                            </article>
                          );
                        })}
                      </div>
                    )}
                  </section>
                );
              })}
            </div>
          )}
        </div>
      </div>
    </Modal>,
  ];
}

function formatSteeringTimestamp(timestamp: number): string {
  return new Intl.DateTimeFormat(undefined, {
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
  }).format(timestamp);
}

function steeringStatus(state: SubagentFleetSteeringState): { label: string; detail: string } {
  return {
    queued: {
      label: "Queued for control channel",
      detail: "Persisted for the pi-subagents runner; it has not confirmed receipt.",
    },
    scheduled: {
      label: "Scheduled",
      detail: "The runner scheduled this for a pending child; Pi has not accepted it yet.",
    },
    routed: {
      label: "Sent to child control inbox",
      detail: "The runner forwarded it to the child; Pi has not accepted it yet.",
    },
    delivered: {
      label: "Pi accepted input",
      detail:
        "Pi accepted the correlated steering input. This does not confirm processing or compliance.",
    },
    late: {
      label: "Pi accepted input late",
      detail:
        "Pi accepted the input after its original delivery window; processing is not confirmed.",
    },
    failed: {
      label: "Delivery failed",
      detail: "The runner or child reported that delivery failed.",
    },
    recovered: {
      label: "Recovered by pi-subagents",
      detail:
        "pi-subagents recovered the child; this is not an acknowledgment that it processed the steer.",
    },
  }[state];
}

function SteeringRequest({ request }: { request: SubagentFleetSteeringRequest }) {
  return (
    <li className="rounded border border-neutral-800/80 bg-neutral-950/60 px-2 py-1.5 light:border-neutral-200 light:bg-neutral-50">
      <div className="flex flex-wrap items-center gap-x-2 gap-y-1 text-[11px] text-neutral-400">
        <span>{formatSteeringTimestamp(request.submittedAt)}</span>
        <span className="font-mono text-[10px] text-neutral-600" title={request.requestId}>
          {request.requestId.slice(0, 12)}
        </span>
        {request.targets.map((target) => {
          const status = steeringStatus(target.state);
          return (
            <span
              key={target.index}
              title={`${status.detail}${target.reason ? ` ${target.reason}` : ""}`}
            >
              child {target.index + 1}: {status.label}
              {target.updatedAt !== undefined
                ? ` (${formatSteeringTimestamp(target.updatedAt)})`
                : ""}
            </span>
          );
        })}
      </div>
      <div className="mt-1 whitespace-pre-wrap break-words text-xs text-neutral-200 light:text-neutral-800">
        {request.messagePreview}
      </div>
      {request.targets.some((target) => target.reason !== undefined) && (
        <div className="mt-1 text-[11px] text-red-300 light:text-red-800">
          {request.targets
            .map((target) => target.reason)
            .filter((reason): reason is string => reason !== undefined)
            .join(" ")}
        </div>
      )}
    </li>
  );
}

function supervisorRequestStatusLabel(status: SubagentSupervisorRequest["status"]): string {
  return {
    open: "open",
    answered: "answered",
    cancelled: "declined",
    expired: "expired",
  }[status];
}

function SupervisorRequests({
  requests,
  onSubmitted,
  onDecline,
}: {
  requests: SubagentSupervisorRequest[];
  onSubmitted: () => Promise<void>;
  onDecline: (requestId: string, trigger: HTMLButtonElement) => void;
}) {
  if (requests.length === 0) return null;
  return (
    <section className="mb-4 rounded-lg border border-amber-800/70 bg-amber-950/20 p-3 light:border-amber-300 light:bg-amber-50">
      <h2 className="text-sm font-medium text-amber-100 light:text-amber-900">
        Supervisor requests
      </h2>
      <p className="mt-1 text-[11px] text-amber-200/80 light:text-amber-800">
        Native pi-subagents requests are correlated to their parent session, run, and request id.
      </p>
      <ul className="mt-3 space-y-2">
        {requests.map((request) => (
          <SupervisorRequestRow
            key={request.requestId}
            request={request}
            onSubmitted={onSubmitted}
            onDecline={onDecline}
          />
        ))}
      </ul>
    </section>
  );
}

const MAX_SUPERVISOR_REPLY_BYTES = 64 * 1024;

function SupervisorRequestRow({
  request,
  onSubmitted,
  onDecline,
}: {
  request: SubagentSupervisorRequest;
  onSubmitted: () => Promise<void>;
  onDecline: (requestId: string, trigger: HTMLButtonElement) => void;
}) {
  const [answer, setAnswer] = useState("");
  const [sending, setSending] = useState(false);
  const [error, setError] = useState<string | undefined>();
  const canReply = request.status === "open" && request.expectsReply;
  const submit = async (): Promise<void> => {
    const normalized = answer.trim();
    if (!canReply || sending) return;
    if (
      !normalized ||
      new TextEncoder().encode(normalized).byteLength > MAX_SUPERVISOR_REPLY_BYTES
    ) {
      setError("A supervisor reply must contain non-whitespace text of at most 64 KiB.");
      return;
    }
    setSending(true);
    setError(undefined);
    try {
      await api.replySubagentSupervisorRequest(request.requestId, normalized);
      setAnswer("");
      await onSubmitted();
    } catch (err) {
      setError(err instanceof ApiError ? (err.message ?? err.code) : (err as Error).message);
    } finally {
      setSending(false);
    }
  };
  let interview: string | undefined;
  if (request.interview !== undefined) {
    try {
      interview = JSON.stringify(request.interview, null, 2);
    } catch {
      interview = "(Structured interview context could not be rendered.)";
    }
  }
  return (
    <li className="rounded border border-amber-800/60 bg-neutral-950/60 p-2.5 text-xs light:border-amber-200 light:bg-white">
      <div className="flex flex-wrap items-center gap-2 text-[11px] text-neutral-400">
        <span className={request.status === "open" ? "text-amber-300" : "text-neutral-400"}>
          {sending ? "sending" : supervisorRequestStatusLabel(request.status)}
        </span>
        <span>{request.reason.replace("_", " ")}</span>
        <span>{formatSteeringTimestamp(request.createdAt)}</span>
        {request.expiresAt !== undefined && request.status === "open" && (
          <span>expires {formatSteeringTimestamp(request.expiresAt)}</span>
        )}
      </div>
      <div className="mt-1 whitespace-pre-wrap break-words text-neutral-100 light:text-neutral-900">
        {request.message}
      </div>
      {interview !== undefined && (
        <pre className="mt-2 max-h-40 overflow-auto rounded bg-neutral-900 p-2 text-[11px] text-neutral-300 light:bg-neutral-100 light:text-neutral-700">
          {interview}
        </pre>
      )}
      <dl className="mt-2 grid grid-cols-[auto_1fr] gap-x-2 gap-y-1 font-mono text-[10px] text-neutral-500">
        <dt>parentSessionId</dt>
        <dd className="break-all">{request.parentSessionId}</dd>
        <dt>runId</dt>
        <dd className="break-all">{request.runId}</dd>
        <dt>requestId</dt>
        <dd className="break-all">{request.requestId}</dd>
      </dl>
      {canReply && (
        <div className="mt-3">
          <label htmlFor={`supervisor-reply-${request.requestId}`} className="sr-only">
            Reply to supervisor request {request.requestId}
          </label>
          <textarea
            id={`supervisor-reply-${request.requestId}`}
            value={answer}
            onChange={(event) => setAnswer(event.target.value)}
            rows={3}
            maxLength={MAX_SUPERVISOR_REPLY_BYTES}
            placeholder="Reply to this exact supervisor request"
            className="w-full resize-y rounded border border-neutral-700 bg-neutral-950 px-2 py-1.5 text-xs text-neutral-100 placeholder:text-neutral-600 light:border-neutral-300 light:bg-white light:text-neutral-900"
          />
          <div className="mt-2 flex justify-end gap-2">
            <button
              type="button"
              onClick={(event) => onDecline(request.requestId, event.currentTarget)}
              disabled={sending}
              className="rounded border border-red-800 px-2 py-1 text-[11px] text-red-200 hover:bg-red-950/60 disabled:opacity-50 light:border-red-300 light:text-red-800"
            >
              Decline
            </button>
            <button
              type="button"
              onClick={() => void submit()}
              disabled={
                sending ||
                answer.trim().length === 0 ||
                new TextEncoder().encode(answer.trim()).byteLength > MAX_SUPERVISOR_REPLY_BYTES
              }
              className="flex items-center gap-1 rounded border border-neutral-700 px-2 py-1 text-[11px] text-neutral-200 hover:border-neutral-500 disabled:opacity-50 light:border-neutral-400 light:text-neutral-700"
            >
              <Send size={11} />
              {sending ? "Sending…" : "Reply"}
            </button>
          </div>
        </div>
      )}
      {error !== undefined && (
        <div
          role="alert"
          aria-live="polite"
          className="mt-2 rounded border border-red-800/60 bg-red-950/30 px-2 py-1.5 text-xs text-red-300 light:border-red-300 light:bg-red-50 light:text-red-800"
        >
          {error}
        </div>
      )}
    </li>
  );
}

function FleetSteering({
  run,
  onSubmitted,
}: {
  run: SubagentFleetRun;
  onSubmitted: () => Promise<void>;
}) {
  const [text, setText] = useState("");
  const [sending, setSending] = useState(false);
  const [error, setError] = useState<string | undefined>();
  const steerable = run.state === "running";

  const submit = async (): Promise<void> => {
    const message = text.trim();
    if (!message || sending || !steerable) return;
    setSending(true);
    setError(undefined);
    try {
      await api.steerSubagentFleetRun(run.runId, message);
      setText("");
      await onSubmitted();
    } catch (err) {
      setError(err instanceof ApiError ? (err.message ?? err.code) : (err as Error).message);
    } finally {
      setSending(false);
    }
  };

  return (
    <div className="border-t border-neutral-800 px-3 py-2 light:border-neutral-200">
      <div className="mb-1 text-xs font-medium text-neutral-300 light:text-neutral-700">
        Live steer
      </div>
      {steerable ? (
        <>
          <div className="flex gap-2">
            <textarea
              value={text}
              onChange={(event) => setText(event.target.value)}
              rows={2}
              maxLength={131072}
              placeholder="Send guidance to the running child or children"
              className="min-w-0 flex-1 resize-y rounded border border-neutral-700 bg-neutral-950 px-2 py-1.5 text-xs text-neutral-100 placeholder:text-neutral-600 light:border-neutral-300 light:bg-white light:text-neutral-900"
            />
            <button
              type="button"
              onClick={() => void submit()}
              disabled={sending || text.trim().length === 0}
              className="flex h-fit items-center gap-1 rounded border border-neutral-700 px-2 py-1.5 text-xs text-neutral-300 hover:border-neutral-500 disabled:opacity-50 light:border-neutral-400 light:text-neutral-700"
            >
              <Send size={12} />
              {sending ? "Queuing…" : "Send steer"}
            </button>
          </div>
          <p className="mt-1 text-[10px] text-neutral-500">
            Queues a control-channel request; it does not interrupt a tool or confirm agent
            processing.
          </p>
        </>
      ) : (
        <p className="text-[11px] text-neutral-500">
          Steering is unavailable because this run is {run.state}. Start a new run to send guidance.
        </p>
      )}
      {error !== undefined && (
        <div className="mt-2 rounded border border-red-800/60 bg-red-950/30 px-2 py-1.5 text-xs text-red-300 light:border-red-300 light:bg-red-50 light:text-red-800">
          {error}
        </div>
      )}
      {run.steering.length > 0 && (
        <div className="mt-2">
          <div className="mb-1 text-[11px] text-neutral-400">Steering for this exact run</div>
          <ul className="space-y-1">
            {run.steering.map((request) => (
              <SteeringRequest key={request.requestId} request={request} />
            ))}
          </ul>
        </div>
      )}
    </div>
  );
}

function ChildRow({
  child,
  index,
  opening,
  openingThis,
  sessionProjectId,
  sessionDiscovered,
  onOpen,
}: {
  child: SubagentFleetChild;
  index: number;
  opening: boolean;
  openingThis: boolean;
  sessionProjectId: string | undefined;
  sessionDiscovered: boolean;
  onOpen: (sessionId: string, projectId: string) => void;
}) {
  const duration = formatSubagentDuration(child.durationMs, child.startedAt, child.endedAt);
  const canOpen = sessionDiscovered && sessionProjectId !== undefined;
  return (
    <div className="rounded border border-neutral-800/80 bg-neutral-950/60 px-2 py-2 text-xs light:border-neutral-200 light:bg-neutral-50">
      <div className="flex flex-wrap items-center gap-2">
        <StatusBadge state={child.state} />
        <span className="font-medium text-neutral-200 light:text-neutral-800">
          {child.agent ?? `Child ${index + 1}`}
        </span>
        {child.model !== undefined && (
          <span className="font-mono text-[11px] text-neutral-400">{child.model}</span>
        )}
        {duration !== undefined && <span className="text-neutral-500">{duration}</span>}
        <div className="flex-1" />
        <button
          type="button"
          onClick={() => {
            if (child.sessionId !== undefined && sessionProjectId !== undefined) {
              onOpen(child.sessionId, sessionProjectId);
            }
          }}
          disabled={!canOpen || opening}
          title={
            canOpen
              ? "Open discovered child session"
              : "Waiting for session discovery; the child session is not available yet."
          }
          className="flex items-center gap-1 rounded border border-neutral-700 px-2 py-1 text-[11px] text-neutral-300 hover:border-neutral-500 disabled:opacity-50 light:border-neutral-400 light:text-neutral-700"
        >
          {openingThis ? (
            <Loader2 size={11} className="animate-spin" />
          ) : (
            <ExternalLink size={11} />
          )}
          {canOpen ? "Open child session" : "Waiting for session discovery"}
        </button>
      </div>
      {child.sessionId !== undefined && (
        <div className="mt-1 truncate font-mono text-[10px] text-neutral-600">
          sessionId: {child.sessionId}
        </div>
      )}
      {child.error !== undefined && (
        <div className="mt-2 whitespace-pre-wrap break-words text-red-300 light:text-red-800">
          {child.error}
        </div>
      )}
    </div>
  );
}

function StatusBadge({ state }: { state: SubagentFleetState }) {
  const config = {
    queued: { icon: Clock3, label: "queued", className: "text-sky-300" },
    running: { icon: Loader2, label: "running", className: "text-cyan-300" },
    complete: { icon: CheckCircle2, label: "complete", className: "text-emerald-300" },
    failed: { icon: XCircle, label: "failed", className: "text-red-300" },
    paused: { icon: PauseCircle, label: "paused", className: "text-amber-300" },
    stopped: { icon: Square, label: "stopped", className: "text-neutral-400" },
  }[state];
  const Icon = config.icon;
  return (
    <span className={`inline-flex items-center gap-1 ${config.className}`}>
      <Icon size={12} className={state === "running" ? "animate-spin" : ""} />
      {config.label}
    </span>
  );
}
