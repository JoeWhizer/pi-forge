import { readOAuthAccessToken } from "./config-manager.js";

export interface CodexUsageWindow {
  label: string;
  usedPercent: number;
  resetAt?: string;
}

export interface CodexUsageSnapshot {
  plan?: string;
  windows: CodexUsageWindow[];
}

type CachedSnapshot = { token: string; expiresAt: number; value: CodexUsageSnapshot | undefined };
let cached: CachedSnapshot | undefined;
let inFlight: Promise<CodexUsageSnapshot | undefined> | undefined;
const CACHE_MS = 60_000;
const USAGE_URL = "https://chatgpt.com/backend-api/wham/usage";

function accountIdFromJwt(token: string): string | undefined {
  try {
    const payload = token.split(".")[1];
    if (payload === undefined) return undefined;
    const json = JSON.parse(Buffer.from(payload, "base64url").toString("utf8")) as Record<
      string,
      unknown
    >;
    const auth = json["https://api.openai.com/auth"];
    if (typeof auth !== "object" || auth === null) return undefined;
    const accountId = (auth as Record<string, unknown>).chatgpt_account_id;
    return typeof accountId === "string" ? accountId : undefined;
  } catch {
    return undefined;
  }
}

function windowLabel(seconds: unknown, fallback: string): string {
  const hours = typeof seconds === "number" && seconds > 0 ? Math.round(seconds / 3600) : undefined;
  return hours === undefined ? fallback : hours >= 168 ? "Week" : `${hours}h`;
}

function parseWindow(value: unknown, fallback: string): CodexUsageWindow | undefined {
  if (typeof value !== "object" || value === null) return undefined;
  const data = value as Record<string, unknown>;
  const used = data.used_percent;
  if (typeof used !== "number" || !Number.isFinite(used)) return undefined;
  const reset = data.reset_at;
  return {
    label: windowLabel(data.limit_window_seconds, fallback),
    usedPercent: Math.max(0, Math.min(100, used)),
    ...(typeof reset === "number" && Number.isFinite(reset)
      ? { resetAt: new Date(reset * 1000).toISOString() }
      : {}),
  };
}

async function fetchUsage(token: string): Promise<CodexUsageSnapshot | undefined> {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 8_000);
  try {
    const headers: Record<string, string> = {
      Authorization: `Bearer ${token}`,
      Accept: "application/json",
      originator: "pi-forge",
    };
    const accountId = accountIdFromJwt(token);
    if (accountId !== undefined) headers["ChatGPT-Account-Id"] = accountId;
    const response = await fetch(USAGE_URL, { headers, signal: controller.signal });
    if (!response.ok) return undefined;
    const body = (await response.json()) as Record<string, unknown>;
    const rateLimit = body.rate_limit;
    if (typeof rateLimit !== "object" || rateLimit === null) return undefined;
    const limits = rateLimit as Record<string, unknown>;
    const windows = [
      parseWindow(limits.primary_window, "5h"),
      parseWindow(limits.secondary_window, "Week"),
    ].filter((window): window is CodexUsageWindow => window !== undefined);
    if (windows.length === 0) return undefined;
    return { ...(typeof body.plan_type === "string" ? { plan: body.plan_type } : {}), windows };
  } catch {
    return undefined;
  } finally {
    clearTimeout(timeout);
  }
}

/** Server-only, secret-free snapshot. Undefined deliberately means no UI status. */
export async function getCodexUsageSnapshot(): Promise<CodexUsageSnapshot | undefined> {
  const token = await readOAuthAccessToken("openai-codex");
  if (token === undefined) return undefined;
  if (cached !== undefined && cached.token === token && cached.expiresAt > Date.now())
    return cached.value;
  if (inFlight !== undefined) return inFlight;
  inFlight = fetchUsage(token).then((value) => {
    cached = { token, value, expiresAt: Date.now() + CACHE_MS };
    return value;
  });
  try {
    return await inFlight;
  } finally {
    inFlight = undefined;
  }
}
