import type { LimitResetInspector, LimitResetRedeemer } from "../../../contracts/account-usage.js";
import { claudeAccountUsage } from "../account-usage.js";
import { claudeEnv } from "../environment.js";
import { CLAUDE_LIMIT_RESET_KINDS, type ClaudeLimitResetKind } from "./screens.js";
import { claudeFiveHourLimitOf, createClaudeLimitResetDriver, type ClaudeFiveHourLimit, type ClaudeLimitResetDriver } from "./driver.js";
import type { ExecutableInstallation } from "../../../contracts/installation.js";
import type { SessionOptions } from "../../../contracts/session-options.js";

/** How long the usage read before the first command may take. */
const FIVE_HOUR_READ_MS = 15_000;

/** One driver per process: it runs one Claude Code UI at a time and keeps the idempotency keys. */
let shared: ClaudeLimitResetDriver | null = null;
function driver(): ClaudeLimitResetDriver {
  shared ??= createClaudeLimitResetDriver();
  return shared;
}

/** The installation's own claude, through its native get_usage, in the call's environment. */
function fiveHourLimit(installation: ExecutableInstallation, env: SessionOptions["env"]): () => Promise<ClaudeFiveHourLimit> {
  return async () => claudeFiveHourLimitOf(await claudeAccountUsage(installation, { ...(env === undefined ? {} : { env }), timeoutMs: FIVE_HOUR_READ_MS }));
}

function isKind(value: string | undefined): value is ClaudeLimitResetKind {
  return CLAUDE_LIMIT_RESET_KINDS.some((kind) => kind === value);
}

/** Opens `/limit-reset <kind>` for each kind and cancels it with Esc; see `Runtime.inspectLimitResets`. */
export const claudeInspectLimitResets: LimitResetInspector = async (installation, options = {}) => {
  if (installation.via !== "executable") { return { kind: "unsupported", reason: "unsupported_installation" }; }
  const consent = options.fiveHourLimitConsent === true;
  const report = await driver().read({
    command: installation.command,
    env: claudeEnv(options.env),
    // Without consent OAR reads usage itself right before the first command.
    atFiveHourLimit: false,
    atFiveHourLimitConsent: consent,
    includeFiveHour: options.includeFiveHour === true,
    fiveHourLimit: fiveHourLimit(installation, options.env),
    ...(options.timeoutMs === undefined ? {} : { timeoutMs: options.timeoutMs }),
  });
  return report.result;
};

/** Opens `/limit-reset <kind>` and accepts its confirmation once; see `Runtime.redeemLimitReset`. */
export const claudeRedeemLimitReset: LimitResetRedeemer = async (installation, options) => {
  if (installation.via !== "executable") { return { kind: "unsupported", reason: "unsupported_installation" }; }
  // A bare /limit-reset can spend with no confirmation, so a kind is required.
  if (!isKind(options.resetId)) { return { kind: "unsupported", reason: "reset_id_required" }; }
  const report = await driver().redeem({
    command: installation.command,
    kind: options.resetId,
    idempotencyKey: options.idempotencyKey,
    env: claudeEnv(options.env),
    fiveHourLimitConsent: options.fiveHourLimitConsent === true,
    fiveHourLimit: fiveHourLimit(installation, options.env),
    ...(options.timeoutMs === undefined ? {} : { timeoutMs: options.timeoutMs }),
  });
  return report.result;
};
