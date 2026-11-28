/* oxlint-disable typescript/promise-function-async -- SDK request callbacks return the native promise. */
import { RequestError } from "@agentclientprotocol/sdk";
import type { RequestRecord, ResponseBody } from "../../contracts/session.js";
import { asRecordList } from "../json.js";
import type { SessionKernel } from "../session-kernel.js";
import type { AcpConfigUpdates } from "./config-updates.js";
import { reportedAcpConfigOptions, setAcpConfigOption } from "./effort.js";
import { AcpError, acpProcessExitedError } from "./errors.js";
import { acpReportedEffort, acpReportedModel } from "./model.js";
import type { AcpProcess } from "./process.js";
import { acpErrorNative } from "./projection.js";

interface AcpConfigControlDeps {
  readonly kernel: SessionKernel;
  readonly runtime: AcpProcess;
  readonly profile: {
    readonly requestTimeoutMs?: number | undefined;
    readonly confirmConfigOptionUpdates?: boolean | undefined;
  };
  readonly configUpdates: AcpConfigUpdates;
}

/**
 * A live ACP config write. The wire answer is a frame correlated with the
 * control; where the profile confirms through config notifications, the same
 * deadline also requires the positive update used at open.
 */
export async function sendAcpConfigOption(
  deps: AcpConfigControlDeps,
  request: RequestRecord,
  configId: string,
  value: string,
): Promise<ResponseBody> {
  const { kernel, runtime, profile } = deps;
  const method = "session/set_config_option";
  if (configId.trim() === "") {
    return { kind: "rejected", code: "unsupported", reason: "configId must not be blank" };
  }
  const gone: ResponseBody = { kind: "rejected", code: "runtime_exited", reason: acpProcessExitedError(runtime.exitCode).message };
  if (runtime.closed) { return gone; }
  try {
    const result = await setAcpConfigOption(runtime, kernel.sessionId, configId, value, {
      timeoutMs: profile.requestTimeoutMs ?? 15_000,
      ...(profile.confirmConfigOptionUpdates === true ? { updates: deps.configUpdates } : {}),
      observe: ({ method: stepMethod, response }) => {
        const model = acpReportedModel(response);
        const effort = acpReportedEffort(response);
        kernel.frame({
          type: stepMethod,
          native: response,
          responseTo: request.id,
          events: [
            ...(model === null ? [] : [{ kind: "model" as const, model }]),
            ...(effort === null ? [] : [{ kind: "effort" as const, effort }]),
          ],
        });
      },
    });
    const effective = reportedAcpConfigOptions(result, configId, value) ?? {};
    const reported = asRecordList(effective.configOptions).find(option => option.id === configId)?.currentValue;
    if (reported !== value) {
      return {
        kind: "rejected",
        code: "error",
        reason: `${method} left ${configId} at ${typeof reported === "string" ? reported : "an unreported value"} although ${value} was requested`,
        native: effective,
      };
    }
    return { kind: "accepted", native: effective };
  } catch (error) {
    if (error instanceof AcpError && error.kind === "process_exited") { return gone; }
    kernel.frame({ type: `${method}/error`, native: acpErrorNative(error), responseTo: request.id, events: [] });
    return {
      kind: "rejected",
      code: error instanceof RequestError ? "runtime_refused" : "error",
      reason: error instanceof Error ? error.message : String(error),
    };
  }
}
