import type { SessionOptions } from "../../contracts/session.js";
import type { JsonRecord } from "../json.js";
import type { AcpSessionProfile, AcpOpenObserver, OpenedAcpSession } from "./profile.js";
import type { AcpProcess } from "./process.js";
import type { AcpConfigUpdates } from "./config-updates.js";
import { applyAcpModel, applyAcpEffort } from "./effort.js";
import { acpOpenStep } from "./failure.js";

export interface AcpModelConfigurationContext {
  readonly options: SessionOptions;
  readonly response: JsonRecord;
  readonly setModel: (model: string) => Promise<JsonRecord | undefined>;
  readonly setEffort: (effort: string, modelResponse: JsonRecord | undefined) => Promise<JsonRecord>;
}
export type AcpModelConfiguration = (context: AcpModelConfigurationContext) => Promise<JsonRecord | undefined>;

/** Profiles choose native selectors; shared calls own deadlines, confirmation and records. */
// oxlint-disable-next-line eslint/max-params -- Same session opening context as profile.ts.
export async function configureAcpModel(
  process: AcpProcess, profile: AcpSessionProfile, options: SessionOptions,
  opened: Pick<OpenedAcpSession, "response" | "sessionId" | "openMethod">,
  observe: AcpOpenObserver, updates?: AcpConfigUpdates,
): Promise<JsonRecord | undefined> {
  const context = { timeoutMs: profile.requestTimeoutMs ?? 15_000, observe, ...(updates === undefined ? {} : { updates }) };
  const setModel = async (model: string): Promise<JsonRecord | undefined> => {
    const result = await acpOpenStep(
    applyAcpModel(process, opened.sessionId, model, { ...context, viaConfigOption: profile.modelViaConfigOption === true }), "model", profile.openFailure);
    return result;
  };
  const setEffort = async (effort: string, response: JsonRecord | undefined): Promise<JsonRecord> => {
    // A model switch can replace its thought-level menu entirely.
    const menu = response !== undefined && Array.isArray(response.configOptions)
      ? { ...opened, response, openMethod: "session/set_config_option" } : opened;
    const result = await applyAcpEffort(process, menu, effort, context);
    return result;
  };
  if (profile.configureModel !== undefined) { return profile.configureModel({ options, response: opened.response, setModel, setEffort }); }
  const response = options.model === undefined ? undefined : await setModel(options.model);
  if (options.effort !== undefined) { await setEffort(options.effort, response); }
  return response;
}
