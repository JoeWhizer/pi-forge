import { useCallback, useEffect, useRef, useState } from "react";
import { api, type SessionContextResponse } from "../lib/api-client";
import { useSessionStore } from "../store/session-store";

interface Props {
  sessionId: string;
}

function formatTokens(value: number): string {
  if (value >= 1_000_000) return `${(value / 1_000_000).toFixed(1)}m`;
  if (value >= 1_000) return `${(value / 1_000).toFixed(1)}k`;
  return String(Math.round(value));
}

function formatCost(value: number): string {
  return new Intl.NumberFormat("en-US", {
    style: "currency",
    currency: "USD",
    minimumFractionDigits: 2,
    maximumFractionDigits: 4,
  }).format(value);
}

function countToolCalls(messages: readonly Record<string, unknown>[]): number {
  let count = 0;
  for (const message of messages) {
    const content = message.content;
    if (!Array.isArray(content)) continue;
    for (const block of content) {
      if (
        typeof block === "object" &&
        block !== null &&
        (block as { type?: unknown }).type === "toolCall"
      ) {
        count++;
      }
    }
  }
  return count;
}

/**
 * Compact, deliberately snapshot-based composer telemetry. It refreshes only
 * after a prompt dispatch or when a tool begins; streaming token deltas never
 * trigger a request or re-render of these values.
 */
export function ComposerContextStatus({ sessionId }: Props) {
  const session = useSessionStore((s) => {
    for (const sessions of Object.values(s.byProject)) {
      const found = sessions.find((candidate) => candidate.sessionId === sessionId);
      if (found !== undefined) return found;
    }
    return undefined;
  });
  const activeTool = useSessionStore((s) => s.activeToolBySession[sessionId]);
  const [data, setData] = useState<SessionContextResponse | undefined>(undefined);
  const refreshRef = useRef<() => void>(() => undefined);
  const previousToolRef = useRef<string | undefined>(undefined);
  const requestRef = useRef<AbortController | undefined>(undefined);

  const refresh = useCallback(() => {
    requestRef.current?.abort();
    const controller = new AbortController();
    requestRef.current = controller;
    void api
      .getSessionContext(sessionId, controller.signal)
      .then((next) => {
        if (!controller.signal.aborted) setData(next);
      })
      // Context telemetry is supplementary. A missing or unavailable session
      // must never add an error banner to the composer.
      .catch(() => undefined);
  }, [sessionId]);

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
    setData(undefined);
    previousToolRef.current = undefined;
    refresh();
    return () => requestRef.current?.abort();
  }, [refresh, sessionId]);

  if (data === undefined) return null;

  const cacheDenominator = data.totalInputTokens + data.totalCacheReadTokens;
  const cacheHit = cacheDenominator > 0 ? (data.totalCacheReadTokens / cacheDenominator) * 100 : 0;
  const sessionLabel = `${session?.name ?? "Untitled"}-${sessionId}`;
  const toolCalls = countToolCalls(data.messages);

  return (
    <div className="flex min-w-0 flex-wrap items-center gap-x-3 gap-y-0.5 border-y border-neutral-800/80 py-1 text-[10px] text-neutral-400 light:border-neutral-200 light:text-neutral-600">
      <span className="max-w-full truncate" title={`Session: ${sessionLabel}`}>
        Session: {sessionLabel}
      </span>
      <span title="Cumulative input, output, and cost for this session">
        Tokens: {formatTokens(data.totalInputTokens)} in / {formatTokens(data.totalOutputTokens)}{" "}
        out · {formatCost(data.totalCost)}
      </span>
      <span title="Prompt-cache reads compared with new input tokens">
        Cache: {cacheHit.toFixed(0)}% Hit · {formatTokens(data.totalCacheReadTokens)} cached ·{" "}
        {formatTokens(data.totalInputTokens)} new
      </span>
      <span title="Completed assistant turns and recorded tool calls">
        Amount turns: {data.turns.length} · {toolCalls} tools used
      </span>
    </div>
  );
}
