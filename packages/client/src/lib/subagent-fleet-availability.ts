import type { ExtensionCommandSummary } from "./api-client";

/** A live session's extension command list is the authoritative client-side availability signal. */
export function hasSubagentFleetExtension(commands: readonly ExtensionCommandSummary[]): boolean {
  return commands.some((command) => command.name === "subagents-fleet");
}
