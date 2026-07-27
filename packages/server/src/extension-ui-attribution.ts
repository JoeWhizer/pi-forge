import { basename } from "node:path";

export type UnsupportedExtensionDialog = {
  extension?: string | undefined;
  method: "select" | "confirm" | "input" | "editor" | "custom";
  title?: string | undefined;
};

/**
 * Extract a display-safe extension identity from an interactive UI call stack.
 * The SDK's ExtensionUIContext deliberately does not expose its caller, so the
 * source file is the only attribution available at this boundary. Never return
 * the complete path: it may expose host filesystem layout to browser clients.
 */
export function extensionNameFromStack(stack: string | undefined): string | undefined {
  if (stack === undefined) return undefined;

  for (const line of stack.split("\n")) {
    const source = line.match(
      /(?:file:\/\/)?([^()\s]+?\.(?:[cm]?[jt]sx?))(?:\?[^:)]+)?(?::\d+:\d+)?/i,
    )?.[1];
    if (source === undefined) continue;

    const normalized = source.replace(/\\/g, "/");
    // Package paths may themselves contain an `extensions/` directory, so
    // identify the package before considering a direct extension directory.
    const packageMatch = normalized.match(/\/node_modules\/((?:@[^/]+\/)?[^/]+)/);
    if (packageMatch?.[1] !== undefined) return packageMatch[1];

    const extensionMarker = "/extensions/";
    const extensionIndex = normalized.lastIndexOf(extensionMarker);
    if (extensionIndex >= 0) {
      const extensionPath = normalized.slice(extensionIndex + extensionMarker.length);
      const parts = extensionPath.split("/");
      // `extensions/foo.ts` is a single-file extension, whereas
      // `extensions/foo/index.ts` identifies the extension directory.
      return parts[0]?.includes(".") === true ? basename(extensionPath) : parts[0];
    }
  }

  return undefined;
}

function summarizeTitle(title: string | undefined): string | undefined {
  const normalized = title?.replace(/\s+/g, " ").trim();
  if (normalized === undefined || normalized.length === 0) return undefined;
  return normalized.slice(0, 160);
}

export function formatUnsupportedExtensionDialog(dialog: UnsupportedExtensionDialog): string {
  const subject =
    dialog.extension === undefined ? "An extension" : `Extension \"${dialog.extension}\"`;
  const title = summarizeTitle(dialog.title);
  const titleSuffix = title === undefined ? "" : ` (\"${title}\")`;
  return `${subject} requested an interactive ${dialog.method} dialog${titleSuffix}, which Pi Forge does not support.`;
}
