import { randomUUID } from "node:crypto";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const repoRoot = resolve(fileURLToPath(new URL("..", import.meta.url)));
let failures = 0;

function assert(label: string, ok: boolean, detail?: string): void {
  if (ok) console.log(`PASS ${label}`);
  else {
    failures += 1;
    console.error(`FAIL ${label}${detail === undefined ? "" : `: ${detail}`}`);
  }
}

async function main(): Promise<void> {
  const fixtureDir = await mkdtemp(join(tmpdir(), "pi-forge-supervisor-test-"));
  process.env.NODE_ENV = "test";
  process.env.WORKSPACE_PATH = fixtureDir;
  process.env.PI_CONFIG_DIR = join(fixtureDir, "config");
  process.env.FORGE_DATA_DIR = join(fixtureDir, "data");

  const external = (await import(
    resolve(repoRoot, "packages/server/dist/subagents-external.js")
  )) as {
    SUBAGENTS_SUPERVISOR_CHANNEL_DIR: string;
    MAX_SUPERVISOR_FILES_PER_REFRESH: number;
    listExternalSupervisorRequests: () => Promise<{ requestId: string }[]>;
  };
  const runId = `supervisor-${randomUUID()}`;
  const requestId = randomUUID();
  const validChannel = join(external.SUBAGENTS_SUPERVISOR_CHANNEL_DIR, `${runId}-worker-0`);
  const noisyChannel = join(
    external.SUBAGENTS_SUPERVISOR_CHANNEL_DIR,
    `unrelated-${randomUUID()}-worker-0`,
  );

  try {
    await Promise.all([
      mkdir(join(validChannel, "requests"), { recursive: true }),
      mkdir(join(noisyChannel, "requests"), { recursive: true }),
    ]);
    await writeFile(
      join(validChannel, "requests", `${requestId}.json`),
      JSON.stringify({
        type: "subagent.supervisor.request",
        id: requestId,
        createdAt: Date.now(),
        expiresAt: Date.now() + 60_000,
        reason: "need_decision",
        message: "Keep accepting valid requests.",
        expectsReply: true,
        orchestratorSessionId: randomUUID(),
        runId,
        agent: "worker",
        childIndex: 0,
      }),
      "utf8",
    );
    await Promise.all(
      Array.from({ length: external.MAX_SUPERVISOR_FILES_PER_REFRESH * 2 }, (_, index) =>
        writeFile(join(noisyChannel, "requests", `malformed-${index}.json`), "{ malformed", "utf8"),
      ),
    );
    await Promise.all(
      Array.from({ length: external.MAX_SUPERVISOR_FILES_PER_REFRESH * 2 }, (_, index) =>
        writeFile(join(noisyChannel, "requests", `unrelated-${index}.txt`), "unrelated", "utf8"),
      ),
    );

    let parseCalls = 0;
    const originalParse = JSON.parse;
    JSON.parse = ((text: string, reviver?: (key: string, value: unknown) => unknown) => {
      parseCalls += 1;
      return originalParse(text, reviver);
    }) as typeof JSON.parse;
    let requests: { requestId: string }[] = [];
    try {
      requests = await external.listExternalSupervisorRequests();
    } finally {
      JSON.parse = originalParse;
    }
    assert(
      "supervisor refresh caps malformed artifact parsing while retaining a valid request",
      parseCalls <= external.MAX_SUPERVISOR_FILES_PER_REFRESH &&
        requests.some((request) => request.requestId === requestId),
      JSON.stringify({ parseCalls, requests }),
    );
  } finally {
    await Promise.all([
      rm(validChannel, { recursive: true, force: true }),
      rm(noisyChannel, { recursive: true, force: true }),
      rm(fixtureDir, { recursive: true, force: true }),
    ]);
  }

  if (failures > 0) process.exit(1);
  console.log("PASS test-subagent-supervisor");
}

await main();
