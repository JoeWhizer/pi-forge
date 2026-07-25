import assert from "node:assert/strict";
import {
  extensionNameFromStack,
  formatUnsupportedExtensionDialog,
} from "../packages/server/src/extension-ui-attribution.js";

assert.equal(
  extensionNameFromStack(
    "Error\n    at handler (file:///home/pi/.pi/agent/extensions/dangerous-command-gate.ts:83:20)",
  ),
  "dangerous-command-gate.ts",
);
assert.equal(
  extensionNameFromStack(
    "Error\n    at command (/app/node_modules/pi-subagents/extensions/dialog.ts:12:4)",
  ),
  "pi-subagents",
);
assert.equal(
  extensionNameFromStack(
    "Error\n    at command (/app/node_modules/@acme/interactive-extension/dist/index.js:12:4)",
  ),
  "@acme/interactive-extension",
);
assert.equal(
  extensionNameFromStack(
    "Error\n    at handler (file:///home/pi/.pi/agent/extensions/plan-mode/index.ts:113:20)",
  ),
  "plan-mode",
);
assert.equal(extensionNameFromStack("Error\n    at unknown (node:internal/tasks:1:1)"), undefined);

assert.equal(
  formatUnsupportedExtensionDialog({
    extension: "dangerous-command-gate.ts",
    method: "confirm",
    title: "  Sicherheitsfreigabe\n erforderlich  ",
  }),
  'Extension "dangerous-command-gate.ts" requested an interactive confirm dialog ("Sicherheitsfreigabe erforderlich"), which Pi Forge does not support.',
);
assert.equal(
  formatUnsupportedExtensionDialog({ method: "custom" }),
  "An extension requested an interactive custom dialog, which Pi Forge does not support.",
);
assert.match(
  formatUnsupportedExtensionDialog({ method: "input", title: "x".repeat(300) }),
  /\(\"x{160}\"\)/,
);

console.log("Extension UI attribution tests passed.");
