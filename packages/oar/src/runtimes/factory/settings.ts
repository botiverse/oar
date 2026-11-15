import type { SessionOptions } from "../../contracts/session.js";
import { UnsupportedOptionError } from "../../contracts/errors.js";
import { ModelConfirmationError } from "../../contracts/model-confirmation-error.js";
import { asRecord, type JsonRecord } from "../../shared/json.js";

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
