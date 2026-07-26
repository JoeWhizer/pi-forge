import { useCallback, useEffect, useRef, useState } from "react";
import { api, type CodexUsageResponse } from "../lib/api-client";
import { useSessionStore } from "../store/session-store";

interface Props {
  sessionId: string;
}

function resetLabel(resetAt: string | undefined): string | undefined {
  if (resetAt === undefined) return undefined;
  const date = new Date(resetAt);
  return Number.isNaN(date.valueOf())
    ? undefined
    : `resets ${date.toLocaleString([], {
        year: "numeric",
        month: "short",
        day: "numeric",
        hour: "2-digit",
        minute: "2-digit",
      })}`;
}

function resetHoursLeft(resetAt: string | undefined, now: number): string | undefined {
  if (resetAt === undefined) return undefined;
  const resetTime = new Date(resetAt).valueOf();
  const remainingMs = resetTime - now;
  if (Number.isNaN(resetTime) || remainingMs <= 0) return undefined;
  return `${Math.ceil(remainingMs / (60 * 60 * 1000))}h left`;
}

/** Renders nothing unless a fresh, authenticated Codex usage snapshot exists. */
export function CodexContextStatus({ sessionId }: Props) {
  const activeTool = useSessionStore((s) => s.activeToolBySession[sessionId]);
  const [usage, setUsage] = useState<CodexUsageResponse | undefined>(undefined);
  const [now, setNow] = useState(Date.now);
  const requestRef = useRef<AbortController | undefined>(undefined);
  const previousToolRef = useRef<string | undefined>(undefined);
  const refreshRef = useRef<() => void>(() => undefined);

  const refresh = useCallback(() => {
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
  }, [sessionId]);
  refreshRef.current = refresh;

  useEffect(() => {
    const interval = window.setInterval(() => setNow(Date.now()), 60_000);
    return () => window.clearInterval(interval);
  }, []);

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
    refresh();
    return () => requestRef.current?.abort();
  }, [refresh, sessionId]);

  const windows = usage?.windows;
  const plan = usage?.plan;
  if (windows === undefined || windows.length === 0) return null;
  return (
    <div className="ml-auto flex min-w-0 flex-wrap justify-end gap-x-2 text-[10px] text-sky-300 light:text-sky-700">
      <span>Codex{plan === undefined ? "" : ` ${plan}`}</span>
      {windows.map((window) => {
        const hoursLeft = resetHoursLeft(window.resetAt, now);
        return (
          <span key={window.label} title={resetLabel(window.resetAt)}>
            {window.label} {Math.round(100 - window.usedPercent)}% left
            {hoursLeft === undefined ? "" : ` - ${hoursLeft}`}
          </span>
        );
      })}
    </div>
  );
}
