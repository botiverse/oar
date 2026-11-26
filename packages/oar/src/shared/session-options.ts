import type { RefusableSessionOption, RefusedSessionOptions } from "../contracts/runtime.js";
import type { SessionOptions } from "../contracts/session.js";
import { UnsupportedOptionError } from "../contracts/errors.js";
import { hasMcpCredentials } from "./mcp-servers.js";
import { configurationExclusions, userConfigurationCategories } from "./user-configuration.js";
import { checkRetainedBytes } from "./record-retention.js";

/** The names of the `mcpServers` entries carrying a credential: `env` on a stdio entry, `headers` on an http one. */
function credentialEntries(options: SessionOptions): readonly string[] {
  return (options.mcpServers ?? []).filter((server) => hasMcpCredentials(server)).map((server) => server.name);
}

/**
 * The refusals every runtime but Pi declares for Pi's two provider options
 * (`SessionOptions.piProvider`, `piCompaction`). A runtime spreads this into its
 * own map, so a host handing a Pi provider declaration to another runtime is
 * refused instead of silently ignored.
 */
export const piOnlyRefusals: RefusedSessionOptions = {
  piProvider: "Only the Pi runtime takes a host-declared provider: this runtime resolves its providers natively",
  piCompaction: "Only the Pi runtime takes a host-declared compaction budget: this runtime configures compaction natively",
};

/**
 * The refusal every runtime but DSH declares for DSH's host-declared provider
 * (`SessionOptions.dshProvider`). A runtime spreads this into its own map, so a
 * host handing a DSH provider declaration to another runtime is refused instead
 * of silently ignored.
 */
export const dshOnlyRefusals: RefusedSessionOptions = {
  dshProvider: "Only the DSH runtime takes a host-declared provider, through its own profile patch: this runtime resolves its providers natively",
};

/** Whether `options` gives `key`: any defined value (including an empty schema), a non-empty map for `env`, a non-empty list for list options, an entry carrying a credential for `mcpServerCredentials`, `exclude` for `userConfiguration`, true for `goals` and `endTurnProcessesOnAbort`, any value for `fork`. */
export function sessionOptionGiven(options: SessionOptions, key: RefusableSessionOption): boolean {
  if (key === "goals") { return options.goals === true; }
  if (key === "endTurnProcessesOnAbort") { return options.endTurnProcessesOnAbort === true; }
  if (key === "userConfiguration" || key === "partialUserConfiguration") {
    const excluded = configurationExclusions(options.userConfiguration);
    return excluded.size > 0 && (key === "userConfiguration" || excluded.size < userConfigurationCategories.length);
  }
  if (key === "env") {
    return options.env !== undefined && Object.keys(options.env).length > 0;
  }
  if (key === "mcpServerCredentials") {
    return credentialEntries(options).length > 0;
  }
  if (key === "mcpServers" || key === "disallowedTools" || key === "launchArgs" || key === "additionalDirectories") {
    return options[key] !== undefined && options[key].length > 0;
  }
  return options[key] !== undefined;
}

/**
 * Reject an open that gives an option the runtime declares refused: an
 * `UnsupportedOptionError` naming it (`mcpServers` for
 * `mcpServerCredentials`), with the declared reason, followed by the refused
 * values for `disallowedTools` and the entries' names for
 * `mcpServerCredentials`.
 */
export function refuseSessionOptions(refused: RefusedSessionOptions, options: SessionOptions): void {
  checkRetainedBytes(options.retainedBytes);
  for (const key of ["systemPrompt", "appendSystemPrompt", "env", "mcpServers", "mcpServerCredentials", "disallowedTools", "launchArgs", "serviceTier", "additionalDirectories", "outputSchema", "name", "userConfiguration", "partialUserConfiguration", "goals", "endTurnProcessesOnAbort", "fork", "nativeMemoryDefault", "sessionLogUpload", "nativePermissions", "modelRequests", "questions", "userQuestions", "piProvider", "piCompaction", "dshProvider"] as const) {
    const reason = refused[key];
    if (reason === undefined || !sessionOptionGiven(options, key)) {
      continue;
    }
    if (key === "mcpServerCredentials") {
      throw new UnsupportedOptionError("mcpServers", `${reason}: ${JSON.stringify(credentialEntries(options))}`);
    }
    const option = key === "partialUserConfiguration" ? "userConfiguration" : key;
    throw new UnsupportedOptionError(option, key === "disallowedTools" ? `${reason}: ${JSON.stringify(options.disallowedTools)}` : reason);
  }
  checkResume(options);
  checkFork(options);
  checkNativePermissions(options);
  checkServiceTierFallback(options);
  checkUserQuestions(options);
}

/**
 * A blank `SessionOptions.resume`, one starting with `-` (which native CLIs
 * with optional `--resume` values read as a flag), or one with a NUL character
 * is refused before anything starts, across every runtime.
 */
export function checkResume(options: SessionOptions): void {
  const resume = options.resume;
  if (resume === undefined) { return; }
  if (resume.trim().length === 0 || resume.startsWith("-") || resume.includes("\0")) {
    throw new UnsupportedOptionError("resume", "resume must be a non-empty session id not starting with - and without NUL characters");
  }
}

/**
 * SessionOptions.fork on a runtime that takes it: `resume` names the source,
 * and a given `through` is a non-blank anchor without NUL characters (no
 * command line can carry one). Refused with `UnsupportedOptionError` on
 * `fork` before anything starts.
 */
function checkFork(options: SessionOptions): void {
  if (options.fork === undefined) { return; }
  if (options.resume === undefined) {
    throw new UnsupportedOptionError("fork", "fork copies the saved session resume names; give resume with the source session id");
  }
  const through = options.fork.through;
  if (through !== undefined && (through.trim().length === 0 || through.includes("\0"))) {
    throw new UnsupportedOptionError("fork", "fork.through must not be blank or contain NUL characters");
  }
}

/**
 * Reject any runtime value outside the `nativePermissions` union before
 * anything starts, so a typo or unmodeled value never silently falls back to
 * OAR's default bypass.
 */
function checkNativePermissions(options: SessionOptions): void {
  const value: unknown = options.nativePermissions;
  if (value !== undefined && value !== "inherit") {
    throw new UnsupportedOptionError("nativePermissions", `nativePermissions must be "inherit" when specified, received ${JSON.stringify(value)}`);
  }
}

/**
 * Reject any runtime value but `"host"`, so a typo never opens a session
 * whose questions nobody holds, and reject giving BOTH question options: they
 * are two dialects of one channel, and a session with two would answer in one
 * vocabulary and describe the other.
 */
function checkUserQuestions(options: SessionOptions): void {
  const value: unknown = options.userQuestions;
  if (value !== undefined && value !== "host") {
    throw new UnsupportedOptionError("userQuestions", `userQuestions must be "host" when specified, received ${JSON.stringify(value)}`);
  }
  if (value !== undefined && options.questions !== undefined) {
    throw new UnsupportedOptionError("userQuestions", 'give either questions: "ask" or userQuestions: "host", not both: they are two dialects of one host-answered question channel');
  }
}

/**
 * Reject runtime values outside the `serviceTierFallback` union and reject
 * `serviceTierFallback` without `serviceTier` before anything starts.
 */
function checkServiceTierFallback(options: SessionOptions): void {
  const value: unknown = options.serviceTierFallback;
  if (value === undefined) { return; }
  if (value !== "default") {
    throw new UnsupportedOptionError("serviceTierFallback", `serviceTierFallback must be "default" when specified, received ${JSON.stringify(value)}`);
  }
  if (options.serviceTier === undefined) {
    throw new UnsupportedOptionError("serviceTierFallback", "serviceTierFallback requires serviceTier to be specified");
  }
}

/**
 * A blank SessionOptions.name, or one with a NUL character, is refused before
 * anything starts, as invalid `additionalDirectories` are: claude and pi
 * would open unnamed without a word, codex would refuse a blank one only
 * after the thread opened (pi's own `--name` refuses it the same way), and
 * no command line can carry a NUL.
 */
export function checkSessionName(options: SessionOptions): void {
  if (options.name !== undefined && (options.name.trim().length === 0 || options.name.includes("\0"))) {
    throw new UnsupportedOptionError("name", "name must not be blank or contain NUL characters");
  }
}
