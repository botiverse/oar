import { UnsupportedOptionError } from "../../contracts/errors.js";

/**
 * claude flags OAR sets itself, which a host's `launchArgs` would contradict
 * (#336): with `--continue` claude exits next to OAR's `--session-id`; after
 * `--fork-session` claude runs under a new id while `Session.id` keeps the
 * old one; `--dangerously-skip-permissions` overrides `--permission-mode`.
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
  ["--permission-mode", "OAR runs claude with --dangerously-skip-permissions, which overrides it"],
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
