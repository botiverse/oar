import { UnsupportedOptionError } from "../../contracts/errors.js";

/**
 * claude flags OAR sets itself, which a host's `launchArgs` would contradict
 * (#336): with `--continue` claude exits next to OAR's `--session-id`; after
 * `--fork-session` claude runs under a new id while `Session.id` keeps the
 * old one. Permission targets require an answer API that OAR does not have.
 * Each maps to the reason the open is refused. A short alias is checked as
 * a whole argument, a long flag also in its `--flag=value` form.
 */
const MANAGED: ReadonlyMap<string, string> = new Map([
  ["--continue", "OAR assigns the session id; use SessionOptions.resume with the id to continue"],
  ["-c", "OAR assigns the session id; use SessionOptions.resume with the id to continue"],
  ["--resume", "use SessionOptions.resume"],
  ["-r", "use SessionOptions.resume"],
  ["--session-id", "OAR assigns the session id"],
  ["--fork-session", "a fork runs under a new native id that Session.id would not report"],
  ["--permission-prompt-tool", "OAR has no interface for answering permission requests"],
  ["--print", "OAR drives claude in print mode over stream-json already"],
  ["-p", "OAR drives claude in print mode over stream-json already"],
  ["--input-format", "OAR drives claude over stream-json"],
  ["--output-format", "OAR drives claude over stream-json"],
  ["--json-schema", "use SessionOptions.outputSchema"],
]);

/** Refuse, before claude starts, a `launchArgs` entry that collides with a flag OAR manages. */
export function refuseManagedLaunchArgs(launchArgs: readonly string[] | undefined): void {
  for (const arg of launchArgs ?? []) {
    const flag = arg.startsWith("--") ? arg.split("=", 1)[0] ?? arg : arg;
    const reason = MANAGED.get(flag);
    if (reason !== undefined) {
      throw new UnsupportedOptionError("launchArgs", `claude launchArgs cannot include ${flag}: ${reason}`);
    }
  }
}

/** Keep explicit native modes noninteractive; omission preserves OAR's default bypass. */
export function claudePermissionArgs(launchArgs: readonly string[] | undefined): readonly string[] {
  const args = launchArgs ?? [];
  let hasMode = false;
  for (const [index, arg] of args.entries()) {
    const [flag] = arg.split("=", 1);
    if (flag !== "--permission-mode" && flag !== "--permission-prompts") { continue; }
    const value = arg.includes("=") ? arg.slice(arg.indexOf("=") + 1) : args[index + 1];
    if (flag === "--permission-mode") {
      if (value === undefined || !["default", "dontAsk", "acceptEdits", "plan"].includes(value)) {
        throw new UnsupportedOptionError("launchArgs", "claude --permission-mode requires default, dontAsk, acceptEdits or plan");
      }
      hasMode = true;
    } else if (value !== "none") {
      throw new UnsupportedOptionError("launchArgs", "claude --permission-prompts only supports none: OAR has no interface for answering permission requests");
    }
  }
  if (hasMode && args.some((arg) => arg.split("=", 1)[0] === "--dangerously-skip-permissions")) {
    throw new UnsupportedOptionError("launchArgs", "claude --dangerously-skip-permissions overrides the requested --permission-mode; choose one permission policy");
  }
  return hasMode ? ["--permission-prompts", "none"] : ["--dangerously-skip-permissions"];
}
