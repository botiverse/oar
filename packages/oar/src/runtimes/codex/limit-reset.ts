import type { LimitResetRedeemer } from "../../contracts/account-usage.js";
import { callAppServer } from "./account-usage.js";
import { projectLimitResetOutcome } from "./reset-credits.js";

/**
 * Spends a reset credit through the call the codex TUI makes. The idempotency
 * key goes to Codex's backend as its redeem request id; Codex bounds that
 * backend call itself at 10 s.
 */
export const codexRedeemLimitReset: LimitResetRedeemer = async (installation, options) => {
  if (options.idempotencyKey.length === 0) {
    throw new Error("idempotencyKey must not be empty");
  }
  if (options.resetId?.length === 0) {
    throw new Error("resetId must not be empty");
  }
  if (installation.via !== "executable") {
    return { kind: "unsupported", reason: "unsupported_installation" };
  }
  const outcome = await callAppServer(
    installation.command,
    options.timeoutMs ?? 20_000,
    "account/rateLimitResetCredit/consume",
    { idempotencyKey: options.idempotencyKey, ...(options.resetId === undefined ? {} : { creditId: options.resetId }) },
    undefined,
    options.env,
  );
  switch (outcome.kind) {
    case "ok":
      return projectLimitResetOutcome(outcome.result);
    case "reauth_required":
      return outcome;
    case "unsupported":
      return outcome;
    case "error":
      break;
  }
  throw new Error("Failed to redeem a Codex limit reset; whether it was spent is unknown, so retry with the same idempotencyKey");
};
