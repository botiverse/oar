/**
 * Small binary-only drivers that share the same thin shape.
 * These CLIs have no reliable machine-readable model list today.
 *
 * Sample (copilot — synthetic, binary present only):
 * ```
 * default (CLI present; no model list API)
 * ```
 *
 * Sample (cursor-agent / gemini): empty model list → models_unavailable when installed.
 */
import { binaryOnly, modelsToInfo } from "../probe.js";
import type { RuntimeDriver } from "../../../backend/trait.js";

export function copilotDriver(): RuntimeDriver {
  return binaryOnly("copilot", "copilot", async () =>
    modelsToInfo("copilot", [
      {
        id: "default",
        label: "default (CLI present; no model list API)",
        supportedReasoningEfforts: ["low", "medium", "high"],
      },
    ]),
  );
}

export function cursorDriver(): RuntimeDriver {
  return binaryOnly("cursor", "cursor-agent", async () => []);
}

export function geminiDriver(): RuntimeDriver {
  return binaryOnly("gemini", "gemini", async () => []);
}
