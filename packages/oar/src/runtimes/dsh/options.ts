import { UnsupportedOptionError } from "../../contracts/errors.js";
import { compareSemver, semverAtLeast } from "../../shared/semver.js";
import type { RefusedSessionOptions } from "../../contracts/runtime.js";
import type { SessionOptions } from "../../contracts/session.js";
import { DSH_MINIMUM_VERSION } from "./version.js";

/** Each stays refused until its own native probe. DSH may well have the concept; OAR has not verified its semantics. */
export const dshRefusedSessionOptions: RefusedSessionOptions = {
  modelRequests: "This adapter has no verified capture of the root agent's provider request",
  fork: "OAR has not verified a native DSH fork that opens a copy of a saved session under a new id, cut after a chosen turn",
  mcpServerCredentials: "DSH MCP env and header persistence has not been audited; only stdio command and args are supported",
  launchArgs: "DSH overlays can disable the OAR bridge; arbitrary launch overlays have no verified final-composition check",
  serviceTier: "DSH has no verified per-session service-tier setting and readback",
  outputSchema: "DSH has no verified final-output schema channel",
  userConfiguration: "DSH default-config dumping omits provider routes with user patches; no verified boot filter preserves providers, login and history",
  endTurnProcessesOnAbort: "DSH cancellation leaves background jobs alive; selected Linux jobs can be killed natively, but complete per-turn process cleanup is not verified",
  nativeMemoryDefault: "DSH exposes no verified below-user default layer for background auto-memory",
};

/** Session-scoped directory grants are effective for file and process writes on these platforms. */
export function dshDirectoryRefusal(version: string | undefined, platform: NodeJS.Platform = process.platform): RefusedSessionOptions {
  if (platform !== "linux" && platform !== "darwin") {
    return { additionalDirectories: "DSH has no verified session-scoped writable roots for both files and shell commands on this platform" };
  }
  const order = version === undefined ? null : compareSemver(version, "0.2.2-rc.3");
  return order !== null && order < 0
    ? { additionalDirectories: "DSH versions below 0.2.2-rc.3 have no session-scoped registerWritableRoot that preserves the existing sandbox policy" }
    : {};
}

/** First DSH release whose `sessionPersistence.stat(id)` returns `location.path` (0.2.1-rc.5 omits `location`). */
export const DSH_NATIVE_SESSION_FILE_VERSION = "0.2.2-alpha.2";

/** Whether this DSH version reports `location.path` from `sessionPersistence.stat(id)`, or undefined when unreadable. */
export function dshSupportsNativeSessionFile(version: string | undefined): boolean | undefined {
  const order = version === undefined ? null : compareSemver(version, DSH_NATIVE_SESSION_FILE_VERSION);
  return order === null ? undefined : order >= 0;
}

/** DSH 0.2.1-rc.5 and later ship @deepseek-ai/dsh-session-log-deepseek (verified on 0.2.1-rc.5 and 0.2.2-rc.5); bridge startup still confirms the row after loader.await(). */
export function dshSessionLogUploadRefusal(version: string | undefined): Pick<RefusedSessionOptions, "sessionLogUpload"> {
  return semverAtLeast(version, DSH_MINIMUM_VERSION)
    ? {}
    : { sessionLogUpload: `DSH session-log upload control requires a verified version of ${DSH_MINIMUM_VERSION} or later` };
}

export interface DshAgentOptions {
  readonly provider?: string;
  readonly model?: string;
  readonly reasoningEffort?: string;
}

/** DSH routes every request by provider and model; a bare model name has no route and would fail only at its first request. */
export function dshAgentOptions(options: Pick<SessionOptions, "model" | "effort">): DshAgentOptions {
  const { model, effort } = options;
  const effortOption = effort === undefined ? {} : { reasoningEffort: effort };
  if (model === undefined) { return effortOption; }
  const separator = model.indexOf("/");
  if (separator <= 0 || separator === model.length - 1) {
    throw new UnsupportedOptionError("model", `DSH selects a model as provider/model, not ${JSON.stringify(model)}`);
  }
  return { provider: model.slice(0, separator), model: model.slice(separator + 1), ...effortOption };
}
