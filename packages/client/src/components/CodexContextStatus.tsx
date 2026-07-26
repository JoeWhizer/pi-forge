import { useCallback, useEffect, useRef, useState } from "react";
import { api, type CodexUsageResponse } from "../lib/api-client";
import { useSessionStore } from "../store/session-store";

interface Props {
  sessionId: string;
  enabled: boolean;
}

function resetLabel(resetAt: string | undefined): string | undefined {
  if (resetAt === undefined) return undefined;
  const date = new Date(resetAt);
  return Number.isNaN(date.valueOf())
    ? undefined
    : `resets ${date.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" })}`;
}

/** Renders nothing unless a fresh, authenticated Codex usage snapshot exists. */
export function CodexContextStatus({ sessionId, enabled }: Props) {
  const activeTool = useSessionStore((s) => s.activeToolBySession[sessionId]);
  const [usage, setUsage] = useState<CodexUsageResponse | undefined>(undefined);
  const requestRef = useRef<AbortController | undefined>(undefined);
  const previousToolRef = useRef<string | undefined>(undefined);
  const refreshRef = useRef<() => void>(() => undefined);

  const refresh = useCallback(() => {
    if (!enabled) {
      setUsage(undefined);
      return;
    }
    requestRef.current?.abort();
    const controller = new AbortController();
    requestRef.current = controller;
    void api
      .getCodexUsage(sessionId, controller.signal)
      .then((next) => {
        if (!controller.signal.aborted) setUsage(next.windows?.length ? next : undefined);
      })
      .catch(() => {
        if (!controller.signal.aborted) setUsage(undefined);
      });
  }, [enabled, sessionId]);
  refreshRef.current = refresh;

  useEffect(() => {
    const onPromptDispatched = (event: Event): void => {
      if ((event as CustomEvent<string>).detail === sessionId) refreshRef.current();
    };
    window.addEventListener("forge:prompt-dispatched", onPromptDispatched);
    return () => window.removeEventListener("forge:prompt-dispatched", onPromptDispatched);
  }, [sessionId]);

  useEffect(() => {
    const toolName = activeTool?.name;
    if (toolName !== undefined && toolName !== previousToolRef.current) refresh();
    previousToolRef.current = toolName;
  }, [activeTool?.name, refresh]);

  useEffect(() => {
    setUsage(undefined);
    previousToolRef.current = undefined;
    return () => requestRef.current?.abort();
  }, [enabled, sessionId]);

  const windows = usage?.windows;
  const plan = usage?.plan;
  if (!enabled || windows === undefined || windows.length === 0) return null;
  return (
    <div className="ml-auto flex min-w-0 flex-wrap justify-end gap-x-2 text-[10px] text-sky-300 light:text-sky-700">
      <span>Codex{plan === undefined ? "" : ` ${plan}`}</span>
      {windows.map((window) => (
        <span key={window.label} title={resetLabel(window.resetAt)}>
          {window.label} {Math.round(100 - window.usedPercent)}% left
        </span>
      ))}
    </div>
  );
}
