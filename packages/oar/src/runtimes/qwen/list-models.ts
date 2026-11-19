import { withQueryDeadline } from "../../shared/executable/query.js";
import { randomUUID } from "node:crypto";
import type { ModelEntry, ModelLister } from "../../contracts/list-models.js";
import { effortLevelsOf } from "../../shared/effort-levels.js";
import { asRecord, asRecordList, parseJson } from "../../shared/json.js";
import { listingCwd } from "../../shared/listing-cwd.js";
import { closeQwen } from "./close.js";
import { launchQwen } from "./launch.js";
import { qwenControl, QWEN_CONTROL_TIMEOUT_MS } from "./control.js";

const missingAuthType = "No auth type is selected. Please configure an auth type (e.g. via settings or `--auth-type`) before running in non-interactive mode.";
class QwenModelAuthenticationError extends Error { override name = "QwenModelAuthenticationError"; }

export function projectQwenModels(payload: unknown): ModelEntry[] {
  return asRecordList(asRecord(payload)?.models).flatMap((model) => {
    if (typeof model.id !== "string" || model.id.length === 0) { return []; }
    const reasoning = asRecord(asRecord(model.capabilities)?.reasoning);
    const effortLevels = effortLevelsOf(reasoning?.efforts);
    return [{ id: model.id,
      ...(typeof model.label === "string" ? { displayName: model.label } : {}),
      ...(effortLevels === undefined ? {} : { effortLevels }),
      ...(typeof reasoning?.defaultEffort === "string" ? { defaultEffort: reasoning.defaultEffort } : {}),
    }];
  });
}

/** Native catalog query; the environment parameter also lets the native harness isolate HOME. */
export async function readQwenModels(command: string, cwd: string, timeoutMs = QWEN_CONTROL_TIMEOUT_MS, env?: Readonly<Record<string, string | null>>): Promise<ModelEntry[]> {
  const result = await withQueryDeadline("Qwen model listing", timeoutMs, async (_signal, own) => {
    const child = own(await launchQwen(command, randomUUID(), { cwd, ...(env === undefined ? {} : { env }) }));
    const control = qwenControl(child, timeoutMs);
    const authentication = { refused: false };
    child.onLine((line) => {
      const value = asRecord(parseJson(line));
      if (value === null) { return; }
      // Native emits this terminal result before answering initialize. Match the
      // observed root startup failure, never model text or arbitrary auth words.
      if (value.type === "result" && value.subtype === "error_during_execution"
        && value.is_error === true && value.num_turns === 0
        && (value.parent_tool_use_id === undefined || value.parent_tool_use_id === null)
        && asRecord(value.error)?.message === missingAuthType) {
        authentication.refused = true;
        control.end();
      } else { control.consume(value); }
    });
    child.onExit(() => { control.end(); });
    try {
      await control.request({ subtype: "initialize" });
      const answer = await control.request({ subtype: "get_available_models" });
      return projectQwenModels(asRecord(answer.response)?.response);
    } catch (error) {
      if (authentication.refused) { throw new QwenModelAuthenticationError("Configure a Qwen authentication type before listing models."); }
      throw error;
    } finally { control.end(); await closeQwen(child); }
  });
  return result;
}

export const qwenListModels: ModelLister = async (installation, options = {}) => {
  if (installation.via !== "executable") { return { kind: "unsupported", reason: "Qwen model listing requires its executable" }; }
  try {
    return { kind: "ok", models: await readQwenModels(installation.command, listingCwd(options), options.timeoutMs, options.env) };
  } catch (error) {
    if (error instanceof QwenModelAuthenticationError) { return { kind: "unauthenticated", detail: error.message }; }
    throw error;
  }
};
