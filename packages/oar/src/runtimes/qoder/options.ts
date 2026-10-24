import type { RefusedSessionOptions } from "../../contracts/runtime.js";
import { UnsupportedOptionError } from "../../contracts/errors.js";

export const qoderRefusedSessionOptions: RefusedSessionOptions = {
  serviceTier: "Qoder has no verified service-tier option",
  outputSchema: "Qoder has no verified structured-output option for long-lived sessions",
  name: "Qoder's session-name persistence has not been verified",
};
export function checkQoderLaunchArgs(args: readonly string[] | undefined): void {
  const managed = new Set(["--print", "-p", "--input-format", "-f", "--output-format", "-o", "--session-id", "--resume", "-r", "--continue", "-c",
    "--fork-session", "--remote", "--remote-session", "--permission-mode", "--permission-prompt-tool", "--reasoning-effort", "--name", "-n",
    "--replay-user-messages", "--no-replay-user-messages", "--"]);
  for (const arg of args ?? []) {
    const flag = arg.split("=", 1)[0] ?? arg;
    if (managed.has(flag)) { throw new UnsupportedOptionError("launchArgs", `Qoder launchArgs cannot override ${flag}; OAR owns the protocol and session identity`); }
  }
}
