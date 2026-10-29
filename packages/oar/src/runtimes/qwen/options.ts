import type { RefusedSessionOptions } from "../../contracts/runtime.js";
import { UnsupportedOptionError } from "../../contracts/errors.js";

export const qwenRefusedSessionOptions: RefusedSessionOptions = {
  goals: "This runtime interface exposes no structured native goal controls",
  userConfiguration: "qwen has no verified separation of user configuration from its native login",
  serviceTier: "Qwen's stream-json interface does not expose a service-tier setting",
  outputSchema: "Qwen rejects --json-schema with its long-lived stream-json input protocol",
  name: "Qwen's stream-json interface does not expose a session-name readback",
};

/** A second protocol, identity, or approval selector would invalidate the session OAR opens. */
export function checkQwenLaunchArgs(args: readonly string[] | undefined): void {
  const managed = new Set([
    "--input-format", "--output-format", "--channel", "--approval-mode", "--yolo", "-y",
    "--session-id", "--resume", "-r", "--continue", "-c", "--fork-session", "--acp",
    "--prompt", "-p", "--json-schema", "-o", "--prompt-interactive", "-i",
    "--experimental-acp", "--json-fd", "--json-file", "--input-file",
    "--sandbox-session-id", "--list-extensions", "-l", "--",
  ]);
  for (const arg of args ?? []) {
    const name = arg.split("=", 1)[0] ?? arg;
    const flag = name.startsWith("--")
      ? name.replaceAll(/[A-Z]/gu, (letter) => `-${letter.toLowerCase()}`)
      : name.slice(0, 2);
    if (managed.has(flag)) {
      throw new UnsupportedOptionError("launchArgs", `Qwen launchArgs cannot override ${flag}; OAR owns the stream-json protocol, session identity, approval mode and output schema`);
    }
  }
}
