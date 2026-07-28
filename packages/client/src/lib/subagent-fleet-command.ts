export const SUBAGENT_FLEET_COMMANDS = [
  {
    name: "subagents-fleet",
    description: "Open the pi-subagents lifecycle fleet",
  },
] as const;

/** Forge intercepts pi-subagents' fleet command for its browser-native, read-only panel. */
export function isSubagentFleetCommand(name: string): boolean {
  return SUBAGENT_FLEET_COMMANDS.some((command) => command.name === name);
}

/** Open the Forge panel instead of passing the command to the extension's terminal dialog. */
export function openSubagentFleetForCommand(name: string, openPanel: () => void): boolean {
  if (!isSubagentFleetCommand(name)) return false;
  openPanel();
  return true;
}
