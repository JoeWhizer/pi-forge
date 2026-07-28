import { readFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import {
  NO_SUPERVISOR_DECISION,
  nativeSupervisorReplyChatPresentation,
} from "../packages/client/src/lib/subagent-supervisor-decision";

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
let failures = 0;

function assert(label: string, ok: boolean, detail?: string): void {
  if (ok) console.log(`PASS ${label}`);
  else {
    failures += 1;
    console.error(`FAIL ${label}${detail === undefined ? "" : `: ${detail}`}`);
  }
}

function replyCall(id: string, replyTo: string, message: unknown): Record<string, unknown> {
  return {
    id,
    name: "subagent_supervisor",
    arguments: { action: "reply", replyTo, ...(message === undefined ? {} : { message }) },
  };
}

function replyResult(
  toolCallId: string,
  replyTo: unknown,
  isError = false,
): Record<string, unknown> {
  return {
    role: "toolResult",
    toolCallId,
    toolName: "subagent_supervisor",
    details: replyTo === undefined ? {} : { replyTo },
    isError,
  };
}

async function main(): Promise<void> {
  const savedSession = (
    await readFile(
      resolve(repoRoot, "tests/fixtures/subagent-supervisor-native-replies-2026-07-28.jsonl"),
      "utf8",
    )
  )
    .trim()
    .split("\n")
    .map((line) => JSON.parse(line) as { type?: unknown; message?: unknown });
  const messages = savedSession.flatMap((entry) =>
    entry.type === "message" ? [entry.message] : [],
  );
  const calls = messages.flatMap((message) => {
    if (typeof message !== "object" || message === null) return [];
    const value = message as { role?: unknown; content?: unknown };
    if (value.role !== "assistant" || !Array.isArray(value.content)) return [];
    return value.content;
  });
  const results = messages.filter((message) => {
    if (typeof message !== "object" || message === null) return false;
    const value = message as { role?: unknown; toolName?: unknown };
    return value.role === "toolResult" && value.toolName === "subagent_supervisor";
  });
  const classifications = calls.map((call) => {
    const id =
      typeof call === "object" && call !== null ? (call as { id?: unknown }).id : undefined;
    const result = results.find(
      (candidate) =>
        typeof candidate === "object" &&
        candidate !== null &&
        (candidate as { toolCallId?: unknown }).toolCallId === id,
    );
    return nativeSupervisorReplyChatPresentation(call, result);
  });

  assert(
    "exact saved native A/B/C replies retain German green/red Chat presentation",
    classifications.join(",") === "approved,approved,rejected",
    JSON.stringify(classifications),
  );

  const englishApprovalWords = ["approved", "approve", "accepted", "proceed", "continue"];
  const englishRejectionWords = ["rejected", "reject", "denied", "declined"];
  assert(
    "historical English native reply wording remains classified",
    englishApprovalWords.every(
      (message, index) =>
        nativeSupervisorReplyChatPresentation(
          replyCall(`english-approve-${index}`, "english-approve", message),
          replyResult(`english-approve-${index}`, "english-approve"),
        ) === "approved",
    ) &&
      englishRejectionWords.every(
        (message, index) =>
          nativeSupervisorReplyChatPresentation(
            replyCall(`english-reject-${index}`, "english-reject", message),
            replyResult(`english-reject-${index}`, "english-reject"),
          ) === "rejected",
      ),
  );

  const validCall = replyCall("call-valid", "request-valid", "genehmigt");
  assert(
    "orphan, mismatched, failed, and incomplete native replies remain neutral",
    nativeSupervisorReplyChatPresentation(validCall, undefined) === NO_SUPERVISOR_DECISION &&
      nativeSupervisorReplyChatPresentation(
        validCall,
        replyResult("call-valid", "different-request"),
      ) === NO_SUPERVISOR_DECISION &&
      nativeSupervisorReplyChatPresentation(
        validCall,
        replyResult("different-call", "request-valid"),
      ) === NO_SUPERVISOR_DECISION &&
      nativeSupervisorReplyChatPresentation(
        validCall,
        replyResult("call-valid", "request-valid", true),
      ) === NO_SUPERVISOR_DECISION &&
      nativeSupervisorReplyChatPresentation(validCall, replyResult("call-valid", undefined)) ===
        NO_SUPERVISOR_DECISION &&
      nativeSupervisorReplyChatPresentation(
        replyCall("call-missing-message", "request-valid", undefined),
        replyResult("call-missing-message", "request-valid"),
      ) === NO_SUPERVISOR_DECISION,
  );

  if (failures > 0) process.exit(1);
  console.log("PASS test-subagent-supervisor-chat");
}

await main();
