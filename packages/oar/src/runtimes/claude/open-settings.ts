import { randomUUID } from "node:crypto";
import type { SessionOptions } from "../../contracts/session.js";
import { asRecord, type JsonRecord } from "../../shared/json.js";
import { mcpCredentialRedactor } from "../../shared/mcp-servers.js";
import { nativeErrorCause } from "../../shared/native-error.js";
import type { ClaudeProcess } from "./launch.js";
import { CLAUDE_EFFORT_READBACK_MS, claudeControlResponseId, claudeEffortRefusal, claudeSettingsRequest } from "./effort.js";
import { claudeServiceTierRefusal } from "./service-tier.js";

type Method = "get_settings" | "initialize";
interface Pending {
  readonly id: string;
  readonly method: Method;
  readonly settle: (answer: JsonRecord | Error) => void;
}
interface OpenSettings {
  /** True only for private get_settings, whose credentials must not enter records. */
  consume(message: JsonRecord): boolean;
  exited(code: number | null): void;
  confirm(options: SessionOptions): Promise<void>;
}

/** Bounded native readbacks at open. Initialization remains in the ordinary projection stream. */
export function claudeOpenSettings(child: ClaudeProcess): OpenSettings {
  let pending: Pending | null = null;
  const privateIds = new Set<string>();
  const lifetime: { exited: boolean; code: number | null } = { exited: false, code: null };
  const exitError = (method: Method): Error => new Error(`claude exited (code ${String(lifetime.code)}) before answering ${method}`);
  const confirm = async (method: Method, option: "effort" | "serviceTier", options: SessionOptions): Promise<void> => {
    const requested = options[option];
    if (requested === undefined) { return; }
    const redact = mcpCredentialRedactor(options.mcpServers);
    const { promise, resolve } = Promise.withResolvers<JsonRecord | Error>();
    const id = `oar-${option}-${randomUUID()}`;
    pending = { id, method, settle: resolve };
    if (method === "get_settings") { privateIds.add(id); }
    const timer = setTimeout(() => { resolve(new Error(`claude did not answer ${method} within ${String(CLAUDE_EFFORT_READBACK_MS)} ms`)); }, CLAUDE_EFFORT_READBACK_MS);
    try {
      if (lifetime.exited) { resolve(exitError(method)); }
      else { child.write(method === "get_settings" ? claudeSettingsRequest(id) : `${JSON.stringify({ type: "control_request", request_id: id, request: { subtype: method } })}\n`); }
      const answer = await promise;
      const refusal = answer instanceof Error ? `${answer.message}, so ${option} ${requested} cannot be confirmed`
        : (option === "effort" ? claudeEffortRefusal(requested, answer) : claudeServiceTierRefusal(requested, answer));
      if (refusal !== null) {
        const response = answer instanceof Error ? null : asRecord(answer.response);
        // A successful get_settings contains merged user config, including
        // credentials unknown to OAR. Only a protocol error belongs here.
        const cause = response?.subtype === "error" ? nativeErrorCause(method, response, redact) : undefined;
        throw new Error(redact(refusal), cause === undefined ? undefined : { cause });
      }
    } catch (error) {
      child.kill();
      await child.exited;
      throw error;
    } finally {
      clearTimeout(timer);
      pending = null;
    }
  };
  return {
    consume(message) {
      const id = claudeControlResponseId(message);
      if (pending !== null && id === pending.id) { pending.settle(message); }
      return id !== null && privateIds.has(id);
    },
    exited(code) {
      lifetime.exited = true;
      lifetime.code = code;
      if (pending !== null) { pending.settle(exitError(pending.method)); }
    },
    async confirm(options) {
      if (options.effort !== undefined) { await confirm("get_settings", "effort", options); }
      if (options.serviceTier !== undefined) { await confirm("initialize", "serviceTier", options); }
    },
  };
}
