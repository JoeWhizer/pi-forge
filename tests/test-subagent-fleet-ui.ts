import { readFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { hasSubagentFleetExtension } from "../packages/client/src/lib/subagent-fleet-availability";

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
let failures = 0;

function assert(label: string, ok: boolean): void {
  if (ok) console.log(`PASS ${label}`);
  else {
    failures += 1;
    console.error(`FAIL ${label}`);
  }
}

async function main(): Promise<void> {
  const appSource = await readFile(resolve(repoRoot, "packages/client/src/App.tsx"), "utf8");

  assert(
    "fleet availability requires the loaded pi-subagents extension command",
    hasSubagentFleetExtension([{ name: "subagents-fleet" }]) &&
      !hasSubagentFleetExtension([{ name: "subagents-stop" }]) &&
      !hasSubagentFleetExtension([]),
  );
  assert(
    "header conditionally renders an accessible fleet button that opens the existing modal",
    appSource.includes("subagentFleetAvailable &&") &&
      appSource.includes("onClick={openSubagentFleet}") &&
      appSource.includes('aria-label="Open subagent fleet"') &&
      appSource.includes('title="Open subagent fleet"') &&
      appSource.includes("<McpStatusBadge />\n          {subagentFleetAvailable &&") &&
      appSource.includes(
        "</button>\n          )}\n          <button\n            onClick={() => setSettingsOpen(true)}",
      ),
  );

  if (failures > 0) process.exitCode = 1;
}

void main();
