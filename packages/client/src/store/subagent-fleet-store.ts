import { create } from "zustand";
import {
  api,
  ApiError,
  type SubagentFleetRun,
  type SubagentSupervisorRequest,
} from "../lib/api-client";
import {
  isCleanableSubagentFleetState,
  isCleanableSubagentSupervisorRequest,
  toggleSubagentFleetExpanded,
} from "../lib/subagent-fleet";

const POLL_INTERVAL_MS = 3_000;
const SUPERVISOR_REQUESTS_EXPANDED_KEY = "pi-forge/subagent-supervisor-requests-expanded";

function readSupervisorRequestsExpanded(): boolean {
  return localStorage.getItem(SUPERVISOR_REQUESTS_EXPANDED_KEY) !== "false";
}

function persistSupervisorRequestsExpanded(expanded: boolean): void {
  localStorage.setItem(SUPERVISOR_REQUESTS_EXPANDED_KEY, String(expanded));
}

let pollTimer: ReturnType<typeof setInterval> | undefined;
let loadGeneration = 0;

interface SubagentFleetState {
  runs: SubagentFleetRun[];
  supervisorRequests: SubagentSupervisorRequest[];
  hiddenRunIds: string[];
  hiddenSupervisorRequestIds: string[];
  sentSupervisorReplyIds: string[];
  stoppingRunIds: string[];
  expandedParents: Record<string, boolean>;
  expandedRuns: Record<string, boolean>;
  expandedSupervisorRequests: Record<string, boolean>;
  supervisorRequestsExpanded: boolean;
  loading: boolean;
  refreshing: boolean;
  lastRefreshedAt: number | undefined;
  error: string | undefined;
  load: (forceRefresh?: boolean) => Promise<void>;
  cleanTerminalRuns: () => void;
  resetCleanedRuns: () => void;
  markSupervisorReplySent: (
    requestId: string,
    decision: SubagentSupervisorRequest["decision"],
  ) => void;
  stopRun: (runId: string) => Promise<void>;
  toggleParentExpanded: (parentKey: string, defaultExpanded: boolean) => void;
  toggleRunExpanded: (runId: string, defaultExpanded: boolean) => void;
  toggleSupervisorRequestExpanded: (requestId: string) => void;
  toggleSupervisorRequestsExpanded: () => void;
  startPolling: () => void;
  stopPolling: () => void;
}

export const useSubagentFleetStore = create<SubagentFleetState>((set, get) => ({
  runs: [],
  supervisorRequests: [],
  hiddenRunIds: [],
  hiddenSupervisorRequestIds: [],
  sentSupervisorReplyIds: [],
  stoppingRunIds: [],
  expandedParents: {},
  expandedRuns: {},
  expandedSupervisorRequests: {},
  supervisorRequestsExpanded: readSupervisorRequestsExpanded(),
  loading: false,
  refreshing: false,
  lastRefreshedAt: undefined,
  error: undefined,
  load: async (forceRefresh = false) => {
    const generation = ++loadGeneration;
    set((state) => ({
      loading: state.runs.length === 0,
      refreshing: forceRefresh,
      error: undefined,
    }));
    try {
      const [{ runs }, { requests: supervisorRequests }] = await Promise.all([
        api.listSubagentFleet(forceRefresh),
        api.listSubagentSupervisorRequests(),
      ]);
      if (generation !== loadGeneration) return;
      set((state) => ({
        runs,
        supervisorRequests,
        stoppingRunIds: state.stoppingRunIds.filter((runId) =>
          runs.some((run) => run.runId === runId && run.state === "running"),
        ),
        sentSupervisorReplyIds: state.sentSupervisorReplyIds.filter((requestId) =>
          supervisorRequests.some(
            (request) => request.requestId === requestId && request.status === "open",
          ),
        ),
        loading: false,
        refreshing: false,
        lastRefreshedAt: Date.now(),
        error: undefined,
      }));
    } catch (err) {
      if (generation !== loadGeneration) return;
      set({
        loading: false,
        refreshing: false,
        error: err instanceof ApiError ? err.code : (err as Error).message,
      });
    }
  },
  cleanTerminalRuns: () => {
    set((state) => ({
      hiddenRunIds: Array.from(
        new Set([
          ...state.hiddenRunIds,
          ...state.runs
            .filter((run) => isCleanableSubagentFleetState(run.state))
            .map((run) => run.runId),
        ]),
      ),
      hiddenSupervisorRequestIds: Array.from(
        new Set([
          ...state.hiddenSupervisorRequestIds,
          ...state.supervisorRequests
            .filter((request) =>
              isCleanableSubagentSupervisorRequest(
                request,
                state.sentSupervisorReplyIds.includes(request.requestId),
              ),
            )
            .map((request) => request.requestId),
        ]),
      ),
    }));
  },
  resetCleanedRuns: () => set({ hiddenRunIds: [], hiddenSupervisorRequestIds: [] }),
  markSupervisorReplySent: (requestId, decision) => {
    set((state) => ({
      sentSupervisorReplyIds: Array.from(new Set([...state.sentSupervisorReplyIds, requestId])),
      supervisorRequests: state.supervisorRequests.map((request) =>
        request.requestId === requestId ? { ...request, decision } : request,
      ),
    }));
  },
  stopRun: async (runId) => {
    if (get().stoppingRunIds.includes(runId)) return;
    set((state) => ({
      stoppingRunIds: [...state.stoppingRunIds, runId],
      error: undefined,
    }));
    try {
      await api.stopSubagentFleetRun(runId);
      await get().load(true);
    } catch (err) {
      set((state) => ({
        stoppingRunIds: state.stoppingRunIds.filter((id) => id !== runId),
        error: err instanceof ApiError ? (err.message ?? err.code) : (err as Error).message,
      }));
    }
  },
  toggleParentExpanded: (parentKey, defaultExpanded) => {
    set((state) => ({
      expandedParents: toggleSubagentFleetExpanded(
        state.expandedParents,
        parentKey,
        defaultExpanded,
      ),
    }));
  },
  toggleRunExpanded: (runId, defaultExpanded) => {
    set((state) => ({
      expandedRuns: toggleSubagentFleetExpanded(state.expandedRuns, runId, defaultExpanded),
    }));
  },
  toggleSupervisorRequestExpanded: (requestId) => {
    set((state) => ({
      expandedSupervisorRequests: toggleSubagentFleetExpanded(
        state.expandedSupervisorRequests,
        requestId,
        false,
      ),
    }));
  },
  toggleSupervisorRequestsExpanded: () => {
    set((state) => {
      const supervisorRequestsExpanded = !state.supervisorRequestsExpanded;
      persistSupervisorRequestsExpanded(supervisorRequestsExpanded);
      return { supervisorRequestsExpanded };
    });
  },
  startPolling: () => {
    if (pollTimer !== undefined) return;
    void get().load();
    pollTimer = setInterval(() => void get().load(), POLL_INTERVAL_MS);
  },
  stopPolling: () => {
    if (pollTimer !== undefined) clearInterval(pollTimer);
    pollTimer = undefined;
    // Ignore an in-flight response after the fleet view has closed.
    loadGeneration += 1;
  },
}));
