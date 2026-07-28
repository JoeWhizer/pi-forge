import { create } from "zustand";
import { api, ApiError, type SubagentFleetRun } from "../lib/api-client";

const POLL_INTERVAL_MS = 3_000;
let pollTimer: ReturnType<typeof setInterval> | undefined;
let loadGeneration = 0;

interface SubagentFleetState {
  runs: SubagentFleetRun[];
  loading: boolean;
  error: string | undefined;
  load: () => Promise<void>;
  startPolling: () => void;
  stopPolling: () => void;
}

export const useSubagentFleetStore = create<SubagentFleetState>((set, get) => ({
  runs: [],
  loading: false,
  error: undefined,
  load: async () => {
    const generation = ++loadGeneration;
    set((state) => ({ loading: state.runs.length === 0, error: undefined }));
    try {
      const { runs } = await api.listSubagentFleet();
      if (generation !== loadGeneration) return;
      set({ runs, loading: false, error: undefined });
    } catch (err) {
      if (generation !== loadGeneration) return;
      set({
        loading: false,
        error: err instanceof ApiError ? err.code : (err as Error).message,
      });
    }
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
