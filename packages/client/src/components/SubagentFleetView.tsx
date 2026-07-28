import { useEffect, useMemo, useRef, useState } from "react";
import {
  CheckCircle2,
  Clock3,
  ExternalLink,
  Loader2,
  PauseCircle,
  RotateCcw,
  Square,
  XCircle,
} from "lucide-react";
import { api, type SubagentFleetChild, type SubagentFleetState } from "../lib/api-client";
import {
  createSubagentFleetNavigationGuard,
  formatSubagentDuration,
  groupSubagentFleetRuns,
  isActiveSubagentFleetState,
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
  const loading = useSubagentFleetStore((state) => state.loading);
  const error = useSubagentFleetStore((state) => state.error);
  const load = useSubagentFleetStore((state) => state.load);
  const startPolling = useSubagentFleetStore((state) => state.startPolling);
  const stopPolling = useSubagentFleetStore((state) => state.stopPolling);
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

  const groups = useMemo(() => groupSubagentFleetRuns(runs), [runs]);
  const sessionsById = useMemo(
    () =>
      new Map(
        Object.values(sessionsByProject)
          .flat()
          .map((session) => [session.sessionId, session] as const),
      ),
    [sessionsByProject],
  );
  const activeCount = runs.filter((run) => isActiveSubagentFleetState(run.state)).length;

  const closeFleet = (): void => {
    navigationGuard.invalidate();
    onClose();
  };

  const openChildSession = async (sessionId: string): Promise<void> => {
    // State updates are not synchronous, so reject rapid clicks before the
    // disabled state reaches every child-session button.
    const token = navigationGuard.start();
    if (token === undefined) return;
    setOpeningSessionId(sessionId);
    setOpenError(undefined);
    try {
      // The existing metadata API resolves live and cold child sessions without
      // resuming them. ChatView then opens the normal (or read-only external)
      // session stream after selection, matching sidebar navigation.
      const summary = await api.getSession(sessionId);
      if (!navigationGuard.isCurrent(token)) return;
      await loadSessionsForProject(summary.projectId);
      if (!navigationGuard.isCurrent(token)) return;
      setActiveProject(summary.projectId);
      setActiveSession(sessionId);
      closeFleet();
    } catch (err) {
      if (navigationGuard.isCurrent(token)) {
        setOpenError(err instanceof Error ? err.message : "session_open_failed");
      }
    } finally {
      if (navigationGuard.isCurrent(token)) {
        navigationGuard.finish(token);
        setOpeningSessionId(undefined);
      }
    }
  };

  return (
    <Modal open onClose={closeFleet} title="Subagent fleet" width="max-w-6xl">
      <div className="flex max-h-[82vh] min-h-64 flex-col overflow-hidden">
        <header className="flex items-center gap-2 border-b border-neutral-800 px-4 py-2 text-xs text-neutral-400 light:border-neutral-200 light:text-neutral-600">
          <span>{activeCount} active</span>
          <span aria-hidden>·</span>
          <span>{runs.length - activeCount} terminal</span>
          <div className="flex-1" />
          <button
            type="button"
            onClick={() => void load()}
            disabled={loading}
            className="flex items-center gap-1 rounded border border-neutral-700 px-2 py-1 text-neutral-300 hover:border-neutral-500 disabled:opacity-50 light:border-neutral-400 light:text-neutral-700"
          >
            <RotateCcw size={12} className={loading ? "animate-spin" : ""} />
            Refresh
          </button>
        </header>

        {(error !== undefined || openError !== undefined) && (
          <div className="border-b border-red-800/60 bg-red-950/30 px-4 py-2 text-xs text-red-300 light:border-red-300 light:bg-red-50 light:text-red-800">
            {openError ?? `Could not load fleet: ${error}`}
          </div>
        )}

        <div className="flex-1 overflow-y-auto p-4">
          {loading && runs.length === 0 ? (
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
                return (
                  <section
                    key={group.parentSessionId ?? "unresolved-parent"}
                    className="rounded-lg border border-neutral-800 bg-neutral-950/50 light:border-neutral-200 light:bg-neutral-50"
                  >
                    <header className="border-b border-neutral-800 px-3 py-2 light:border-neutral-200">
                      <div className="truncate text-sm font-medium text-neutral-100 light:text-neutral-900">
                        {parentLabel}
                      </div>
                      {group.parentSessionId !== undefined && (
                        <div className="truncate font-mono text-[10px] text-neutral-500">
                          parentSessionId: {group.parentSessionId}
                        </div>
                      )}
                    </header>
                    <div className="space-y-2 p-3">
                      {group.runs.map((run) => {
                        const duration = formatSubagentDuration(
                          run.durationMs,
                          run.startedAt,
                          run.endedAt,
                        );
                        return (
                          <article
                            key={run.runId}
                            className="rounded-md border border-neutral-800 bg-neutral-900/70 light:border-neutral-200 light:bg-white"
                          >
                            <div className="flex flex-wrap items-center gap-2 px-3 py-2 text-xs">
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
                              <div className="flex-1" />
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
                            </div>
                            {run.error !== undefined && (
                              <div className="border-t border-red-900/50 bg-red-950/20 px-3 py-2 text-xs text-red-300 light:border-red-200 light:bg-red-50 light:text-red-800">
                                {run.error}
                              </div>
                            )}
                            {run.children.length > 0 && (
                              <div className="border-t border-neutral-800 px-3 py-2 light:border-neutral-200">
                                <div className="ml-2 space-y-1 border-l border-neutral-700 pl-3 light:border-neutral-300">
                                  {run.children.map((child, index) => (
                                    <ChildRow
                                      key={child.childId}
                                      child={child}
                                      index={index}
                                      opening={openingSessionId !== undefined}
                                      openingThis={openingSessionId === child.sessionId}
                                      onOpen={(sessionId) => void openChildSession(sessionId)}
                                    />
                                  ))}
                                </div>
                              </div>
                            )}
                          </article>
                        );
                      })}
                    </div>
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
  onOpen,
}: {
  child: SubagentFleetChild;
  index: number;
  opening: boolean;
  openingThis: boolean;
  onOpen: (sessionId: string) => void;
}) {
  const duration = formatSubagentDuration(child.durationMs, child.startedAt, child.endedAt);
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
        {child.sessionId !== undefined && (
          <button
            type="button"
            onClick={() => {
              if (child.sessionId !== undefined) onOpen(child.sessionId);
            }}
            disabled={opening}
            className="flex items-center gap-1 rounded border border-neutral-700 px-2 py-1 text-[11px] text-neutral-300 hover:border-neutral-500 disabled:opacity-50 light:border-neutral-400 light:text-neutral-700"
          >
            {openingThis ? (
              <Loader2 size={11} className="animate-spin" />
            ) : (
              <ExternalLink size={11} />
            )}
            Open child session
          </button>
        )}
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
