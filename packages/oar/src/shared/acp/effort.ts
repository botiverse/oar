/* oxlint-disable typescript/promise-function-async -- Deadline callbacks deliberately return the SDK's native promises. */
import { AcpError } from "./errors.js";
import { UnsupportedOptionError } from "../../contracts/errors.js";
import { asRecord, asRecordList, type JsonRecord } from "../json.js";
import { acpReportedEffort, acpThoughtLevelOption } from "./model.js";
import { type AcpProcess, withAcpDeadline } from "./process.js";
import type { AcpConfigUpdates } from "./config-updates.js";

type ObserveStep = (step: { readonly method: string; readonly response: JsonRecord }) => void;

/** The verbatim answer, and with confirmation the `config_option_update` that reported the requested value. */
interface ConfigOptionResult { readonly response: JsonRecord | undefined; readonly confirmed?: JsonRecord }

/**
 * `session/set_config_option`, its answer observed as it arrives so the record
 * keeps the wire order (a confirming notification recorded after a stale
 * answer stays the current value).
 */
async function setConfigOption(
  process: AcpProcess, sessionId: string, configId: string, value: string,
  context: { readonly timeoutMs: number; readonly updates?: AcpConfigUpdates; readonly confirmWhenStale?: boolean; readonly observe: ObserveStep },
): Promise<ConfigOptionResult> {
  const method = "session/set_config_option";
  const { updates } = context;
  if (updates === undefined) {
    const answer = await withAcpDeadline(process, method, context.timeoutMs, requestOptions =>
      process.connection.agent.request(method, { sessionId, configId, value }, requestOptions));
    const response = asRecord(answer) ?? undefined;
    context.observe({ method, response: response ?? {} });
    return { response };
  }
  return updates.confirm(sessionId, configId, value, wait =>
    withAcpDeadline(process, method, context.timeoutMs, async requestOptions => {
      const response = asRecord(await process.connection.agent.request(method, { sessionId, configId, value }, requestOptions)) ?? undefined;
      context.observe({ method, response: response ?? {} });
      if (context.confirmWhenStale === true
        && asRecordList(response?.configOptions).find(option => option.id === configId)?.currentValue === value) {
        return { response };
      }
      const signals = [process.connection.signal, ...(requestOptions?.cancellationSignal === undefined ? [] : [requestOptions.cancellationSignal])];
      return { response, confirmed: await wait(AbortSignal.any(signals)) };
    }));
}

/**
 * The options that report the setting: the answer, unless it still shows
 * another value for `configId` and a notification confirmed the requested one.
 * Dim (0.1.0-alpha.29) answers an effort change made right after a model
 * switch with the previous level and pushes the applied one after it.
 */
function reportedOptions({ response, confirmed }: ConfigOptionResult, configId: string, value: string): JsonRecord | undefined {
  const answered = asRecordList(response?.configOptions).find(option => option.id === configId);
  return confirmed === undefined || answered?.currentValue === value ? response : confirmed;
}

/** An RPC error's message plus its `data` (grok puts the reason there: "unknown reasoning_effort value"). */
function rpcErrorText(error: unknown): string {
  if (!(error instanceof Error)) {
    return String(error);
  }
  const data = asRecord(error)?.data;
  if (data === undefined || data === null) {
    return error.message;
  }
  return `${error.message} (${typeof data === "string" ? data : JSON.stringify(data)})`;
}

/**
 * Apply `SessionOptions.effort` through the agent's `thought_level` config
 * option (model.ts): `session/set_config_option {configId, value}`, whose
 * answer lists every option with its current value. The answer is observed
 * like any handshake answer (a frame carrying the `effort` event), and
 * anything but the requested level as the option's `currentValue` refuses the
 * open: an agent without the option, one that refuses the value (grok 1.0.41
 * and kimi 2.0.0 answer `-32602 Invalid params`), or one that applies another.
 * Applied after `session/set_model`, because a model switch re-derives the
 * option's menu for the new model.
 */
export async function applyAcpEffort(
  process: AcpProcess,
  opened: { readonly response: JsonRecord; readonly sessionId: string; readonly openMethod: string },
  effort: string,
  context: {
    readonly timeoutMs: number;
    readonly updates?: AcpConfigUpdates;
    readonly confirmWhenStale?: boolean;
    readonly observe: ObserveStep;
  },
): Promise<JsonRecord> {
  const configId = acpThoughtLevelOption(opened.response)?.id;
  if (typeof configId !== "string" || configId.length === 0) {
    // No effort channel at all: the option, not the level, is what this
    // runtime cannot honor (docs/design/capabilities.md).
    throw new UnsupportedOptionError("effort", `${opened.openMethod} advertises no thought_level config option, so effort ${effort} cannot be applied`);
  }
  const method = "session/set_config_option";
  let result: ConfigOptionResult | undefined = undefined;
  try {
    result = await setConfigOption(process, opened.sessionId, configId, effort, context);
  } catch (error) {
    // The opener adds the owned child's exit diagnostics to transport failures.
    if (error instanceof AcpError) { throw error; }
    throw new Error(`${method} ${configId}=${effort} was refused: ${rpcErrorText(error)}`, { cause: error });
  }
  const response = reportedOptions(result, configId, effort) ?? {};
  const applied = acpReportedEffort(response);
  if (applied !== effort) {
    throw new Error(`${method} left ${configId} at ${applied ?? "an unreported value"} although effort ${effort} was requested`);
  }
  return response;
}

/**
 * Apply `SessionOptions.model`: `session/set_model {modelId}`, or with
 * `viaConfigOption` `session/set_config_option` on the `model` option (for
 * agents whose set_model answer reports nothing, agy_acp_server 1.2.1).
 * The answer is observed like any handshake answer and returned.
 */
export async function applyAcpModel(
  process: AcpProcess,
  sessionId: string,
  model: string,
  context: {
    readonly viaConfigOption: boolean;
    readonly timeoutMs: number;
    readonly updates?: AcpConfigUpdates;
    readonly confirmWhenStale?: boolean;
    readonly observe: ObserveStep;
  },
): Promise<JsonRecord | undefined> {
  if (context.viaConfigOption) {
    return reportedOptions(await setConfigOption(process, sessionId, "model", model, context), "model", model);
  }
  const method = "session/set_model";
  const response = asRecord(await withAcpDeadline(
    process,
    method,
    context.timeoutMs,
    (requestOptions) => process.connection.agent.request(method, { sessionId, modelId: model }, requestOptions),
  )) ?? undefined;
  context.observe({ method, response: response ?? {} });
  return response;
}
