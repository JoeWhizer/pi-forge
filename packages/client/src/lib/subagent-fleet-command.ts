export const SUBAGENT_FLEET_COMMANDS = [
  {
    name: "subagent-fleet",
    description: "Open the pi-subagents lifecycle fleet",
  },
  {
    name: "subagents-fleet",
    description: "Open the pi-subagents lifecycle fleet (alias)",
  },
] as const;

/** Forge-owned aliases for its browser-native, read-only fleet panel. */
export function isSubagentFleetCommand(name: string): boolean {
  return SUBAGENT_FLEET_COMMANDS.some((command) => command.name === name);
}

/** Open the Forge panel instead of passing its aliases to an extension command. */
export function openSubagentFleetForCommand(name: string, openPanel: () => void): boolean {
  if (!isSubagentFleetCommand(name)) return false;
  openPanel();
  return true;
}
