/* oxlint-disable typescript/promise-function-async -- Deadline callbacks deliberately return the SDK's native promises. */
import { asRecord, type JsonRecord } from "../json.js";
import { acpReportedEffort, acpThoughtLevelOption } from "./model.js";
import { type AcpProcess, withAcpDeadline } from "./process.js";

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
    readonly observe: (step: { readonly method: string; readonly response: JsonRecord }) => void;
  },
): Promise<void> {
  const configId = acpThoughtLevelOption(opened.response)?.id;
  if (typeof configId !== "string" || configId.length === 0) {
    throw new Error(`${opened.openMethod} advertises no thought_level config option, so effort ${effort} cannot be applied`);
  }
  const method = "session/set_config_option";
  let answer: unknown = undefined;
  try {
    answer = await withAcpDeadline(
      process,
      method,
      context.timeoutMs,
      (requestOptions) => process.connection.agent.request(
        method,
        { sessionId: opened.sessionId, configId, value: effort },
        requestOptions,
      ),
    );
  } catch (error) {
    throw new Error(`${method} ${configId}=${effort} was refused: ${rpcErrorText(error)}`, { cause: error });
  }
  const response = asRecord(answer) ?? {};
  context.observe({ method, response });
  const applied = acpReportedEffort(response);
  if (applied !== effort) {
    throw new Error(`${method} left ${configId} at ${applied ?? "an unreported value"} although effort ${effort} was requested`);
  }
}
