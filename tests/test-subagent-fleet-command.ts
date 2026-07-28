import {
  isSubagentFleetCommand,
  openSubagentFleetForCommand,
  SUBAGENT_FLEET_COMMANDS,
} from "../packages/client/src/lib/subagent-fleet-command";
import { useUiStore } from "../packages/client/src/store/ui-store";

let failures = 0;
function assert(label: string, ok: boolean, detail?: string): void {
  if (ok) console.log(`  PASS  ${label}`);
  else {
    failures += 1;
    console.log(`  FAIL  ${label}${detail ? ` — ${detail}` : ""}`);
  }
}

function main(): void {
  assert(
    "fleet command map includes only the pi-subagents plural command",
    SUBAGENT_FLEET_COMMANDS.map((command) => command.name).join(",") === "subagents-fleet",
  );
  assert(
    "Forge-invented singular command is not intercepted",
    !isSubagentFleetCommand("subagent-fleet"),
  );
  assert("fleet command map excludes unrelated extension commands", !isSubagentFleetCommand("run"));
  assert(
    "collision filtering retains unrelated pi-subagents extension commands",
    ["subagents-fleet", "subagents-stop"].filter(
      (command) => !isSubagentFleetCommand(command),
    )[0] === "subagents-stop",
  );

  for (const command of SUBAGENT_FLEET_COMMANDS) {
    useUiStore.getState().closeSubagentFleet();
    const opened = openSubagentFleetForCommand(command.name, () =>
      useUiStore.getState().openSubagentFleet(),
    );
    assert(
      `/${command.name} opens the Forge browser fleet panel`,
      opened && useUiStore.getState().subagentFleetOpen,
    );
  }

  useUiStore.getState().closeSubagentFleet();
  const singularOpened = openSubagentFleetForCommand("subagent-fleet", () =>
    useUiStore.getState().openSubagentFleet(),
  );
  assert(
    "Forge-invented singular command does not open the Forge fleet panel",
    !singularOpened && !useUiStore.getState().subagentFleetOpen,
  );

  const unrelatedOpened = openSubagentFleetForCommand("subagents-stop", () =>
    useUiStore.getState().openSubagentFleet(),
  );
  assert(
    "unrelated extension commands are not remapped to the Forge fleet panel",
    !unrelatedOpened && !useUiStore.getState().subagentFleetOpen,
  );

  if (failures > 0) {
    console.log(`\n[test-subagent-fleet-command] FAIL — ${failures} assertion(s) failed`);
    process.exit(1);
  }
  console.log("\n[test-subagent-fleet-command] PASS");
}

main();
