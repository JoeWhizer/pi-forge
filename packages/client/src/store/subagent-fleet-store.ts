import { create } from "zustand";
import { api, ApiError, type SubagentFleetRun } from "../lib/api-client";
import { isCleanableSubagentFleetState } from "../lib/subagent-fleet";

const POLL_INTERVAL_MS = 3_000;
let pollTimer: ReturnType<typeof setInterval> | undefined;
let loadGeneration = 0;

interface SubagentFleetState {
  runs: SubagentFleetRun[];
  hiddenRunIds: string[];
  expandedParents: Record<string, boolean>;
  expandedRuns: Record<string, boolean>;
  loading: boolean;
  refreshing: boolean;
  lastRefreshedAt: number | undefined;
  error: string | undefined;
  load: (forceRefresh?: boolean) => Promise<void>;
  cleanTerminalRuns: () => void;
  resetCleanedRuns: () => void;
  toggleParentExpanded: (parentKey: string, defaultExpanded: boolean) => void;
  toggleRunExpanded: (runId: string, defaultExpanded: boolean) => void;
  startPolling: () => void;
  stopPolling: () => void;
}

export const useSubagentFleetStore = create<SubagentFleetState>((set, get) => ({
  runs: [],
  hiddenRunIds: [],
  expandedParents: {},
  expandedRuns: {},
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
      const { runs } = await api.listSubagentFleet(forceRefresh);
      if (generation !== loadGeneration) return;
      set({
        runs,
        loading: false,
        refreshing: false,
        lastRefreshedAt: Date.now(),
        error: undefined,
      });
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
    }));
  },
  resetCleanedRuns: () => set({ hiddenRunIds: [] }),
  toggleParentExpanded: (parentKey, defaultExpanded) => {
    set((state) => ({
      expandedParents: {
        ...state.expandedParents,
        [parentKey]: !(state.expandedParents[parentKey] ?? defaultExpanded),
      },
    }));
  },
  toggleRunExpanded: (runId, defaultExpanded) => {
    set((state) => ({
      expandedRuns: {
        ...state.expandedRuns,
        [runId]: !(state.expandedRuns[runId] ?? defaultExpanded),
      },
    }));
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
