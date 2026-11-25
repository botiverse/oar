/* oxlint-disable import/max-dependencies -- The ACP profile composes Hermes launch, refusals and resume classification. */
import type { SessionOptions } from "../../contracts/session.js";
import { acpSession, type AcpSessionProfile } from "../../shared/acp/session.js";
import { acpReportedEffort, acpReportedModel } from "../../shared/acp/model.js";
import { asRecord, type JsonRecord } from "../../shared/json.js";
import { refuseSessionOptions } from "../../shared/session-options.js";
import { hermesInstallationRefusals } from "./mcp-credentials.js";
import { hermesRefusedSessionOptions } from "./options.js";

/**
 * The shipped `hermes-acp` entry is a viewer of the Hermes gateway daemon:
 * `initialize` advertises protocol 1, image prompts, `loadSession`, and the
 * unstable `session/fork`, `session/list` and `session/resume` methods. The
 * gateway owns turns, MCP tools, provider credentials and persistence; OAR
 * speaks ACP to it and never reaches into the profile.
 */
export const hermesAcpArgs: readonly string[] = ["acp"];

/**
 * A missing resume target reaches OAR as the gateway's own `not_found`
 * reason. The ACP SDK serializes a gateway `GatewayClientError` as an
 * internal-error reply with `data.details` (observed with
 * `hermes-acp 0.23.3+1139.g084538c`); the gateway's `_attach_info` uses the
 * same reason for a deleted or unknown conversation.
 */
export function hermesResumeNotFound(native: JsonRecord): boolean {
  if (native.code !== -32_603) { return false; }
  const details = asRecord(native.data)?.details;
  return details === "not_found" || native.message === "not_found";
}

// Hermes resolves its provider from the profile's own configuration; the
// advertised `hermes-setup` and provider auth methods are for interactive
// editors, and OAR never starts that setup out of band (`selectAuthMethod`
// stays absent).
export const hermesAcpProfile: AcpSessionProfile = {
  args: hermesAcpArgs,
  // A second session/prompt can become a new turn. Only the structured extension fences a steer.
  capabilities: { queue: { durable: false }, attribution: "opaque" },
  // oxlint-disable-next-line eslint/no-underscore-dangle -- ACP extension capability envelope.
  steerRequestAdvertised: initialized => asRecord(initialized._meta)?.["hermes/steer"] === true,
  steerRequest: ({ sessionId, input }) => ({ method: "_hermes/session/steer", params: { sessionId, text: input } }),
  steerRequestImages: "paths",
  steerRequestErrorsUnknown: true,
  steerRequestAnswer: answer => {
    switch (asRecord(answer)?.status) {
      case "queued": return "accepted";
      case "no_active_turn": return "no_active_turn";
      default: return null;
    }
  },
  // The gateway mounts a fresh session, its model picker and its gateway
  // connection; the first open is seconds, not milliseconds.
  requestTimeoutMs: 60_000,
  // The gateway's select pickers are the supported setters: `model` goes
  // through `set_config_option` -> `set_session_model`, and the full option
  // list it answers is the applied model's readback. `set_session_model`
  // alone answers `{}` and pushes nothing.
  modelViaConfigOption: true,
  configureModel: async ({ options, response, setModel, setEffort }) => {
    // Hermes rebuilds its model inventory on every setter, even for a no-op.
    const requestedModel = options.model;
    const changeModel = requestedModel !== undefined && requestedModel !== acpReportedModel(response);
    const selected = changeModel ? await setModel(requestedModel) : undefined;
    if (options.effort !== undefined && (changeModel || options.effort !== acpReportedEffort(response))) {
      await setEffort(options.effort, selected);
    }
    return selected;
  },
  // `session/fork` copies the whole conversation under a new id, never a
  // turn-cut copy.
  wholeSessionFork: true,
  isResumeNotFound: hermesResumeNotFound,
  validateOptions: (options: SessionOptions, installation): void => {
    // The static map and the release-specific one together: `sessionCapabilities()`
    // reads the same `hermesInstallationRefusals`, so the declaration and this open
    // agree on whether an entry with `env` or `headers` attaches.
    refuseSessionOptions({ ...hermesRefusedSessionOptions, ...hermesInstallationRefusals(installation) }, options);
  },
};

export const hermesSession = acpSession(hermesAcpProfile);
