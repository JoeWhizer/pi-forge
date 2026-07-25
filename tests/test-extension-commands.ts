/**
 * SDK extension command integration test.
 *
 * Verifies that registered commands are listed from a live session and are
 * forwarded through the existing prompt endpoint without model/auth preflight.
 * The streaming assertion toggles the SDK's internal active-run marker only to
 * exercise its documented command-before-queue dispatch without an LLM.
 */
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
const repoRoot = resolve(__dirname, "..");

let failures = 0;
function assert(label: string, ok: boolean, detail?: string): void {
  if (ok) console.log(`  PASS  ${label}`);
  else {
    failures += 1;
    console.log(`  FAIL  ${label}${detail ? ` — ${detail}` : ""}`);
  }
}

interface JsonResponse {
  status: number;
  body: unknown;
}

async function request(base: string, path: string, init?: RequestInit): Promise<JsonResponse> {
  const res = await fetch(`${base}${path}`, init);
  const text = await res.text();
  return { status: res.status, body: text === "" ? undefined : JSON.parse(text) };
}

async function waitForSseEvents(
  response: Response,
  matches: ((event: Record<string, unknown>) => boolean)[],
): Promise<Record<string, unknown>[]> {
  const reader = response.body?.getReader();
  if (reader === undefined) throw new Error("SSE response has no body");
  const decoder = new TextDecoder();
  const found: (Record<string, unknown> | undefined)[] = [];
  for (let i = 0; i < matches.length; i += 1) found.push(undefined);
  let foundCount = 0;
  let pending = "";
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) throw new Error("SSE stream ended before matching events");
      pending += decoder.decode(value, { stream: true });
      for (;;) {
        const boundary = pending.indexOf("\n\n");
        if (boundary === -1) break;
        const frame = pending.slice(0, boundary);
        pending = pending.slice(boundary + 2);
        const line = frame.split("\n").find((entry) => entry.startsWith("data: "));
        if (line === undefined) continue;
        const event = JSON.parse(line.slice("data: ".length)) as Record<string, unknown>;
        for (let i = 0; i < matches.length; i += 1) {
          const matcher = matches[i];
          if (matcher !== undefined && found[i] === undefined && matcher(event)) {
            found[i] = event;
            foundCount += 1;
          }
        }
        if (foundCount === matches.length) {
          return found.filter((match): match is Record<string, unknown> => match !== undefined);
        }
      }
    }
  } finally {
    await reader.cancel().catch(() => undefined);
  }
}

async function main(): Promise<void> {
  const workspacePath = await mkdtemp(join(tmpdir(), "pi-forge-extension-commands-ws-"));
  const configDir = await mkdtemp(join(tmpdir(), "pi-forge-extension-commands-cfg-"));
  const dataDir = await mkdtemp(join(tmpdir(), "pi-forge-extension-commands-data-"));
  process.env.WORKSPACE_PATH = workspacePath;
  process.env.PI_CONFIG_DIR = configDir;
  process.env.FORGE_DATA_DIR = dataDir;
  process.env.SESSION_DIR = join(workspacePath, ".pi", "sessions");
  process.env.NODE_ENV = "test";
  delete process.env.UI_PASSWORD;
  delete process.env.JWT_SECRET;
  delete process.env.API_KEY;

  await mkdir(join(configDir, "extensions"), { recursive: true });
  await writeFile(
    // The SDK discovers direct extension files with .js or .ts suffixes.
    join(configDir, "extensions", "test-command.js"),
    [
      "export default function testCommand(pi) {",
      '  pi.registerCommand("test-command", {',
      '    description: "Set the session name from command arguments",',
      "    handler: async (args, ctx) => {",
      '      const opts = args === "abort" ? (() => { const controller = new AbortController(); setTimeout(() => controller.abort(), 10); return { signal: controller.signal }; })() : undefined;',
      '      const first = ctx.ui.confirm("Test dialog", "Approve this test extension action?", opts);',
      '      const second = args === "double" ? await ctx.ui.confirm("Second dialog", "This must fail closed.") : undefined;',
      "      const approved = await first;",
      '      const suffix = second === undefined ? "" : `:${second}`;',
      '      ctx.ui.notify(`Command feedback: ${args}:${approved}${suffix}`, "info");',
      "      pi.setSessionName(`extension:${args}:${approved}${suffix}`);",
      "    },",
      "  });",
      "}",
      "",
    ].join("\n"),
    "utf8",
  );

  const buildModule = (await import(
    resolve(repoRoot, "packages/server/dist/index.js")
  )) as unknown as {
    buildServer: () => Promise<{
      listen: (opts: { port: number; host: string }) => Promise<string>;
      close: () => Promise<void>;
    }>;
  };
  const registry = (await import(
    resolve(repoRoot, "packages/server/dist/session-registry.js")
  )) as unknown as {
    getSession: (id: string) =>
      | {
          session: {
            _isAgentRunActive: boolean;
            sessionManager: { appendMessage: (message: unknown) => string };
          };
        }
      | undefined;
    disposeSession: (id: string) => Promise<boolean>;
  };

  const fastify = await buildModule.buildServer();
  const base = await fastify.listen({ port: 0, host: "127.0.0.1" });

  try {
    const project = await request(base, "/api/v1/projects", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ name: "extension-commands", path: workspacePath }),
    });
    assert("create project → 201", project.status === 201, JSON.stringify(project.body));
    const projectId = (project.body as { id: string }).id;

    const created = await request(base, "/api/v1/sessions", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ projectId }),
    });
    assert("create session → 201", created.status === 201, JSON.stringify(created.body));
    const sessionId = (created.body as { sessionId: string }).sessionId;

    const commands = await request(base, `/api/v1/sessions/${sessionId}/extension-commands`);
    const commandList = (commands.body as { commands?: { name: string; description?: string }[] })
      .commands;
    const testCommand = commandList?.find((command) => command.name === "test-command");
    assert(
      "GET live extension commands → 200",
      commands.status === 200,
      JSON.stringify(commands.body),
    );
    assert(
      "registered command name is listed without slash",
      testCommand !== undefined,
      JSON.stringify(commands.body),
    );
    assert(
      "registered command description is listed",
      testCommand?.description === "Set the session name from command arguments",
      JSON.stringify(commands.body),
    );

    const sseController = new AbortController();
    const stream = await fetch(`${base}/api/v1/sessions/${sessionId}/stream`, {
      signal: sseController.signal,
    });
    assert("open SSE stream for extension rename → 200", stream.status === 200);
    const confirmationEvent =
      stream.status === 200
        ? waitForSseEvents(stream, [(event) => event.type === "ask_user_question"])
        : undefined;

    const invoke = await request(base, `/api/v1/sessions/${sessionId}/prompt`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ text: "/test-command normal" }),
    });
    assert(
      "extension command prompt → 202 without a model",
      invoke.status === 202,
      JSON.stringify(invoke.body),
    );
    let confirmation: Record<string, unknown> | undefined;
    try {
      if (invoke.status === 202 && confirmationEvent !== undefined) {
        await new Promise((resolveFn) => setTimeout(resolveFn, 25));
        [confirmation] = await Promise.race([
          confirmationEvent,
          new Promise<never>((_, reject) =>
            setTimeout(
              () => reject(new Error("timed out waiting for confirmation SSE event")),
              1_000,
            ),
          ),
        ]);
      }
    } catch (err) {
      assert(
        "extension confirmation reaches the authenticated session SSE stream",
        false,
        err instanceof Error ? err.message : String(err),
      );
    } finally {
      // Always close the stream: Fastify.close() waits for open SSE clients.
      sseController.abort();
      await confirmationEvent?.catch(() => undefined);
    }
    const presentation = confirmation?.presentation as
      | { kind?: string; title?: string; message?: string; extension?: string }
      | undefined;
    assert(
      "extension confirm emits Forge-native confirmation SSE",
      presentation?.kind === "confirmation" &&
        presentation.title === "Test dialog" &&
        presentation.message === "Approve this test extension action?" &&
        presentation.extension === "test-command.js",
      JSON.stringify(confirmation),
    );
    const confirmationRequestId = confirmation?.requestId;
    const reject =
      typeof confirmationRequestId === "string"
        ? await request(base, `/api/v1/sessions/${sessionId}/ask-user-question/answer`, {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({
              requestId: confirmationRequestId,
              answers: [
                { questionIndex: 0, question: "Test dialog", kind: "option", answer: "Reject" },
              ],
            }),
          })
        : { status: 0, body: undefined };
    assert("Reject confirmation answer → 204", reject.status === 204, JSON.stringify(reject.body));
    await new Promise((resolveFn) => setTimeout(resolveFn, 25));
    const afterNormal = await request(base, `/api/v1/sessions/${sessionId}`);
    assert(
      "Reject makes extension confirm return false",
      (afterNormal.body as { name?: string }).name === "extension:normal:false",
      JSON.stringify(afterNormal.body),
    );
    const afterCommandMessages = await request(base, `/api/v1/sessions/${sessionId}/messages`);
    assert(
      "extension command creates no canonical user message",
      (afterCommandMessages.body as { messages?: unknown[] }).messages?.length === 0,
      JSON.stringify(afterCommandMessages.body),
    );

    const live = registry.getSession(sessionId);
    if (live !== undefined) live.session._isAgentRunActive = true;
    const streamingInvoke = await request(base, `/api/v1/sessions/${sessionId}/prompt`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ text: "/test-command streaming" }),
    });
    if (live !== undefined) live.session._isAgentRunActive = false;
    assert(
      "extension command prompt → 202 while streaming without queue mode",
      streamingInvoke.status === 202,
      JSON.stringify(streamingInvoke.body),
    );
    await new Promise((resolveFn) => setTimeout(resolveFn, 25));
    const pendingStreaming = await request(
      base,
      `/api/v1/sessions/${sessionId}/ask-user-question/pending`,
    );
    const streamingRequestId = (pendingStreaming.body as { pending?: { requestId: string }[] })
      .pending?.[0]?.requestId;
    assert(
      "streaming command opens a pending confirmation",
      typeof streamingRequestId === "string",
      JSON.stringify(pendingStreaming.body),
    );
    const approve =
      typeof streamingRequestId === "string"
        ? await request(base, `/api/v1/sessions/${sessionId}/ask-user-question/answer`, {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({
              requestId: streamingRequestId,
              answers: [
                { questionIndex: 0, question: "Test dialog", kind: "option", answer: "Approve" },
              ],
            }),
          })
        : { status: 0, body: undefined };
    assert(
      "Approve confirmation answer → 204",
      approve.status === 204,
      JSON.stringify(approve.body),
    );
    await new Promise((resolveFn) => setTimeout(resolveFn, 25));
    const afterStreaming = await request(base, `/api/v1/sessions/${sessionId}`);
    assert(
      "explicit Approve makes extension confirm return true",
      (afterStreaming.body as { name?: string }).name === "extension:streaming:true",
      JSON.stringify(afterStreaming.body),
    );

    const doubleInvoke = await request(base, `/api/v1/sessions/${sessionId}/prompt`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ text: "/test-command double" }),
    });
    assert("extension command with two confirms → 202", doubleInvoke.status === 202);
    await new Promise((resolveFn) => setTimeout(resolveFn, 25));
    const pendingDouble = await request(base, `/api/v1/sessions/${sessionId}/ask-user-question/pending`);
    const doubleRequestId = (pendingDouble.body as { pending?: { requestId: string }[] }).pending?.[0]
      ?.requestId;
    assert(
      "second extension confirmation does not replace the first",
      typeof doubleRequestId === "string" &&
        (pendingDouble.body as { pending?: unknown[] }).pending?.length === 1,
      JSON.stringify(pendingDouble.body),
    );
    const answerDouble =
      typeof doubleRequestId === "string"
        ? await request(base, `/api/v1/sessions/${sessionId}/ask-user-question/answer`, {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({
              requestId: doubleRequestId,
              answers: [
                { questionIndex: 0, question: "Test dialog", kind: "option", answer: "Approve" },
              ],
            }),
          })
        : { status: 0, body: undefined };
    assert(
      "Approve first of two confirmations → 204",
      answerDouble.status === 204,
      JSON.stringify(answerDouble.body),
    );
    await new Promise((resolveFn) => setTimeout(resolveFn, 25));
    const afterDouble = await request(base, `/api/v1/sessions/${sessionId}`);
    assert(
      "second extension confirmation returns false fail-closed",
      (afterDouble.body as { name?: string }).name === "extension:double:true:false",
      JSON.stringify(afterDouble.body),
    );

    const abortInvoke = await request(base, `/api/v1/sessions/${sessionId}/prompt`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ text: "/test-command abort" }),
    });
    assert("extension command with aborted confirm → 202", abortInvoke.status === 202);
    await new Promise((resolveFn) => setTimeout(resolveFn, 50));
    const afterAbort = await request(base, `/api/v1/sessions/${sessionId}`);
    assert(
      "aborted confirmation returns false and cleans up",
      (afterAbort.body as { name?: string }).name === "extension:abort:false",
      JSON.stringify(afterAbort.body),
    );
    const afterAbortPending = await request(
      base,
      `/api/v1/sessions/${sessionId}/ask-user-question/pending`,
    );
    assert(
      "aborted confirmation leaves no pending request",
      (afterAbortPending.body as { pending?: unknown[] }).pending?.length === 0,
      JSON.stringify(afterAbortPending.body),
    );

    // The SDK deliberately defers JSONL creation until an assistant message
    // exists. Add a minimal assistant fixture so this test can cover the
    // route's cold-session resume path without an LLM or API key.
    if (live !== undefined) {
      live.session.sessionManager.appendMessage({
        role: "assistant",
        content: [{ type: "text", text: "test fixture", id: "stub-1" }],
        api: "messages",
        provider: "anthropic",
        model: "test-fixture",
        usage: {
          input: 0,
          output: 0,
          cacheRead: 0,
          cacheWrite: 0,
          totalTokens: 0,
          cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
        },
        stopReason: "stop",
        timestamp: Date.now(),
      });
    }
    assert("persist session for cold command lookup", live !== undefined);

    const disposed = await registry.disposeSession(sessionId);
    assert("dispose session before cold command lookup", disposed);
    // disposeSession tombstones briefly to block stale SSE reconnects; wait
    // through that guard before exercising the cold-session resume path.
    await new Promise((resolveFn) => setTimeout(resolveFn, 1_600));
    const coldCommands = await request(base, `/api/v1/sessions/${sessionId}/extension-commands`);
    assert(
      "cold extension command lookup lazy-resumes → 200",
      coldCommands.status === 200,
      JSON.stringify(coldCommands.body),
    );
    assert(
      "cold extension command lookup retains registered commands",
      (coldCommands.body as { commands?: { name: string }[] }).commands?.some(
        (command) => command.name === "test-command",
      ) === true,
      JSON.stringify(coldCommands.body),
    );

    const missing = await request(base, "/api/v1/sessions/not-a-live-session/extension-commands");
    assert("extension commands for unknown session → 404", missing.status === 404);
  } finally {
    await fastify.close();
    await rm(workspacePath, { recursive: true, force: true }).catch(() => undefined);
    await rm(configDir, { recursive: true, force: true }).catch(() => undefined);
    await rm(dataDir, { recursive: true, force: true }).catch(() => undefined);
  }

  if (failures > 0) {
    console.log(`\n[test-extension-commands] FAIL — ${failures} assertion(s) failed`);
    process.exit(1);
  }
  console.log("\n[test-extension-commands] PASS");
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
