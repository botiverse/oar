import { UnsupportedOptionError } from "../../contracts/errors.js";
import type { SessionFork } from "../../contracts/session-options.js";
import type { JsonRecord } from "../../shared/json.js";
import { checkManagedLaunchArgs, normalizeLaunchFlag } from "../../shared/launch-args.js";

/**
 * claude flags OAR sets itself, which a host's `launchArgs` would contradict
 * (#336): with `--continue` claude exits next to OAR's `--session-id`; after
 * `--fork-session` claude ran under a new id while `Session.id` kept the old
 * one (SessionOptions.fork passes it with the id OAR assigns). Permission targets require an answer API that OAR does not have.
 * Each maps to the reason the open is refused. A short alias is checked as
 * a whole argument or attached value, a long flag also in its `--flag=value` form.
 */
const MANAGED: ReadonlyMap<string, string> = new Map([
  ["--continue", "OAR assigns the session id; use SessionOptions.resume with the id to continue"],
  ["-c", "OAR assigns the session id; use SessionOptions.resume with the id to continue"],
  ["--resume", "use SessionOptions.resume"],
  ["-r", "use SessionOptions.resume"],
  ["--session-id", "OAR assigns the session id"],
  ["--fork-session", "use SessionOptions.fork with resume: OAR assigns the fork's id so Session.id reports it"],
  ["--permission-prompt-tool", "OAR has no interface for answering permission requests"],
  ["--print", "OAR drives claude in print mode over stream-json already"],
  ["-p", "OAR drives claude in print mode over stream-json already"],
  ["--input-format", "OAR drives claude over stream-json"],
  ["--output-format", "OAR drives claude over stream-json"],
  ["--include-partial-messages", "OAR drives claude over partial stream-json messages"],
  ["--no-include-partial-messages", "OAR drives claude over partial stream-json messages"],
  ["--replay-user-messages", "OAR drives claude with user-message replay"],
  ["--no-replay-user-messages", "OAR drives claude with user-message replay"],
  ["--model", "use SessionOptions.model"],
  ["--effort", "use SessionOptions.effort"],
  ["--system-prompt", "use SessionOptions.systemPrompt"],
  ["--system-prompt-file", "use SessionOptions.systemPrompt"],
  ["--append-system-prompt", "use SessionOptions.appendSystemPrompt"],
  ["--append-system-prompt-file", "use SessionOptions.appendSystemPrompt"],
  ["--name", "use SessionOptions.name"],
  ["-n", "use SessionOptions.name"],
  ["--json-schema", "use SessionOptions.outputSchema"],
  ["--", "OAR passes flags after host launchArgs"],
]);

/** Refuse, before claude starts, a `launchArgs` entry that collides with a flag OAR manages. */
export function refuseManagedLaunchArgs(launchArgs: readonly string[] | undefined): void {
  checkManagedLaunchArgs(launchArgs, MANAGED, (flag, reason) => `claude launchArgs cannot include ${flag}: ${reason ?? "managed by OAR"}`);
}

/**
 * With SessionOptions.fork, OAR sets `--resume-session-at` itself (launch.ts),
 * and a host's copy after it would silently replace `fork.through`. Without a
 * fork the flag stays the host's, as before.
 */
export function refuseForkLaunchArgs(launchArgs: readonly string[] | undefined, fork: SessionFork | undefined): void {
  if (fork === undefined) { return; }
  if ((launchArgs ?? []).some((arg) => arg.split("=", 1)[0] === "--resume-session-at")) {
    throw new UnsupportedOptionError("launchArgs", "claude launchArgs cannot include --resume-session-at with SessionOptions.fork: use fork.through");
  }
}

/** Claude replaces the entire --settings value on repetition, including when it names a file. */
export function claudeSettingsArgs(settings: JsonRecord, launchArgs: readonly string[] | undefined): readonly string[] {
  if (Object.keys(settings).length === 0) { return []; }
  if ((launchArgs ?? []).some((arg) => normalizeLaunchFlag(arg) === "--settings")) {
    throw new UnsupportedOptionError("launchArgs", "claude launchArgs cannot include --settings when OAR supplies session settings");
  }
  return ["--settings", JSON.stringify(settings)];
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
