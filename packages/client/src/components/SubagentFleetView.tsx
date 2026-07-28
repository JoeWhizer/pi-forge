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
  Square,
  Trash2,
  XCircle,
} from "lucide-react";
import { type SubagentFleetChild, type SubagentFleetState } from "../lib/api-client";
import {
  createSubagentFleetNavigationGuard,
  filterCleanedSubagentFleetRuns,
  formatSubagentDuration,
  groupSubagentFleetRuns,
  isActiveSubagentFleetState,
  isCleanableSubagentFleetState,
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
  const hiddenRunIds = useSubagentFleetStore((state) => state.hiddenRunIds);
  const expandedParents = useSubagentFleetStore((state) => state.expandedParents);
  const expandedRuns = useSubagentFleetStore((state) => state.expandedRuns);
  const loading = useSubagentFleetStore((state) => state.loading);
  const refreshing = useSubagentFleetStore((state) => state.refreshing);
  const lastRefreshedAt = useSubagentFleetStore((state) => state.lastRefreshedAt);
  const error = useSubagentFleetStore((state) => state.error);
  const load = useSubagentFleetStore((state) => state.load);
  const cleanTerminalRuns = useSubagentFleetStore((state) => state.cleanTerminalRuns);
  const resetCleanedRuns = useSubagentFleetStore((state) => state.resetCleanedRuns);
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
  const navigationGuardRef = useRef(createSubagentFleetNavigationGuard());
  const navigationGuard = navigationGuardRef.current;

  useEffect(() => {
    startPolling();
    return stopPolling;
  }, [startPolling, stopPolling]);

  useEffect(() => () => navigationGuard.invalidate(), [navigationGuard]);

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

  return (
    <Modal open onClose={closeFleet} title="Subagent fleet" width="max-w-6xl">
      <div className="flex max-h-[82vh] min-h-64 flex-col overflow-hidden">
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
                              <button
                                type="button"
                                onClick={() => toggleRunExpanded(run.runId, defaultRunExpanded)}
                                aria-expanded={isRunExpanded}
                                aria-label={
                                  isRunExpanded
                                    ? `Collapse run ${run.runId}`
                                    : `Expand run ${run.runId}`
                                }
                                className="flex w-full flex-wrap items-center gap-2 px-3 py-2 text-left text-xs hover:bg-neutral-800/50 light:hover:bg-neutral-50"
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
                              {isRunExpanded && (
                                <>
                                  {run.error !== undefined && (
                                    <div className="border-t border-red-900/50 bg-red-950/20 px-3 py-2 text-xs text-red-300 light:border-red-200 light:bg-red-50 light:text-red-800">
                                      {run.error}
                                    </div>
                                  )}
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
    </Modal>
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
