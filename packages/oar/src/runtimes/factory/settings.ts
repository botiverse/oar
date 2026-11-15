import type { SessionOptions } from "../../contracts/session.js";
import { UnsupportedOptionError } from "../../contracts/errors.js";
import { ModelConfirmationError } from "../../contracts/model-confirmation-error.js";
import { asRecord, type JsonRecord } from "../../shared/json.js";
import type { DroidClient, DroidOutcome } from "./client.js";

const SETTINGS_REPORT_MS = 10_000;

/** droid's own refusal of an effort outside its enum (-32602 naming `reasoningEffort`), as the typed refusal of that option. */
export function effortRefusal(error: unknown, options: SessionOptions): UnsupportedOptionError | null {
  const native = asRecord(asRecord(error instanceof Error ? error.cause : null)?.native);
  const message = typeof native?.message === "string" ? native.message : "";
  return options.effort !== undefined && native?.code === -32_602 && message.includes("reasoningEffort")
    ? new UnsupportedOptionError("effort", `droid refused effort ${JSON.stringify(options.effort)}: ${message}`) : null;
}

/**
 * Why droid's reported settings refuse the open: it ran another model or
 * effort than requested (an unknown model falls back, an unlisted effort is
 * clamped). No catalog is read for this check.
 */
export function settingsRefusal(options: SessionOptions, settings: JsonRecord | null, when: string): Error | null {
  if (options.model !== undefined && settings?.modelId !== options.model) {
    const reported = typeof settings?.modelId === "string" ? settings.modelId : null;
    return new ModelConfirmationError(`droid did not apply model ${JSON.stringify(options.model)}${when}; reported ${JSON.stringify(reported)}`, { requested: options.model, reported });
  }
  if (options.effort !== undefined && settings?.reasoningEffort !== options.effort) {
    return new UnsupportedOptionError("effort", `droid did not apply effort ${JSON.stringify(options.effort)}${when}; reported ${JSON.stringify(settings?.reasoningEffort ?? null)}`);
  }
  return null;
}

/**
 * Confirm the model and effort droid runs. A resumed session runs what it
 * saved: when the request differs, set it with `update_session_settings`
 * (its reply recorded by `record`) and take droid's next pushed settings, which
 * `listen` receives, as its word.
 */
export async function confirmSettings(client: DroidClient, options: SessionOptions, settings: JsonRecord | null, record: (outcome: DroidOutcome) => void, listen: (waiter: ((pushed: JsonRecord) => void) | null) => void): Promise<void> {
  const differs = (options.model !== undefined && settings?.modelId !== options.model) || (options.effort !== undefined && settings?.reasoningEffort !== options.effort);
  if (options.resume === undefined || !differs) {
    const refusal = settingsRefusal(options, settings, "");
    if (refusal !== null) { throw refusal; }
    return;
  }
  const { promise: reported, resolve } = Promise.withResolvers<JsonRecord | null>();
  listen(resolve);
  const timer = setTimeout(() => { resolve(null); }, SETTINGS_REPORT_MS);
  try {
    try {
      await client.request("droid.update_session_settings", { ...(options.model === undefined ? {} : { modelId: options.model }), ...(options.effort === undefined ? {} : { reasoningEffort: options.effort }) }, record);
    } catch (error) { throw effortRefusal(error, options) ?? error; }
    const refusal = settingsRefusal(options, await reported, " on resume");
    if (refusal !== null) { throw refusal; }
  } finally { clearTimeout(timer); listen(null); }
}
