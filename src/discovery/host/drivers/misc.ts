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
import { commandInstallAttempts, withInstallAttempts } from "../../installDetect.js";

export function copilotDriver(): RuntimeDriver {
  return withInstallAttempts(
    binaryOnly("copilot", "copilot", async () =>
      modelsToInfo("copilot", [
        {
          id: "default",
          label: "default (CLI present; no model list API)",
          supportedReasoningEfforts: ["low", "medium", "high"],
        },
      ]),
    ),
    commandInstallAttempts(["copilot"]),
  );
}

export function cursorDriver(): RuntimeDriver {
  return withInstallAttempts(
    binaryOnly("cursor", "cursor-agent", async () => []),
    commandInstallAttempts(["cursor-agent"]),
  );
}

export function geminiDriver(): RuntimeDriver {
  return withInstallAttempts(
    binaryOnly("gemini", "gemini", async () => []),
    commandInstallAttempts(["gemini"]),
  );
}
