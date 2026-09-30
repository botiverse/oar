import type { SessionOptions } from "../../contracts/session.js";
import { randomUUID } from "node:crypto";
import type { JsonRecord } from "../../shared/json.js";
import {
  CLAUDE_READBACK_MS,
  claudeControlResponseId,
  claudeEffortRefusal,
  claudeSettingsRequest,
} from "./effort.js";
import { claudeListModelsRequest, claudeModelRefusal } from "./model.js";

/**
 * The control requests the adapter asks claude at open (see session.ts): each
 * answer is taken off the line stream before the fold, never recorded.
 */
export interface ClaudeReadbacks {
  /** Settles the read-back `message` answers and reports true, or false for any other frame. */
  readonly take: (message: JsonRecord) => boolean;
  /** claude exited: every read-back still waiting gets an error naming its request. */
  readonly exited: (code: number | null) => void;
  /**
   * Why claude will not run the requested model or effort, both named, or
   * null when it runs exactly what `options` asked for (or asked for neither).
   */
  readonly refusal: (options: SessionOptions) => Promise<string | null>;
}

export function createClaudeReadbacks(write: (line: string) => void): ClaudeReadbacks {
  const pending = new Map<string, { readonly subtype: string; readonly settle: (answer: JsonRecord | Error) => void }>();

  const ask = async (subtype: string, request: (id: string) => string): Promise<JsonRecord | Error> => {
    const { promise: answered, resolve } = Promise.withResolvers<JsonRecord | Error>();
    const id = `oar-${subtype}-${randomUUID()}`;
    pending.set(id, { subtype, settle: resolve });
    const timer = setTimeout(() => {
      resolve(new Error(`claude did not answer ${subtype} within ${String(CLAUDE_READBACK_MS)} ms`));
    }, CLAUDE_READBACK_MS);
    write(request(id));
    const answer = await answered;
    clearTimeout(timer);
    pending.delete(id);
    return answer;
  };

  return {
    take: (message) => {
      const readback = pending.get(claudeControlResponseId(message) ?? "");
      readback?.settle(message);
      return readback !== undefined;
    },
    exited: (code) => {
      for (const readback of pending.values()) {
        readback.settle(new Error(`claude exited (code ${String(code)}) before answering ${readback.subtype}`));
      }
    },
    refusal: async ({ model, effort }) => {
      if (model === undefined && effort === undefined) {
        return null;
      }
      const [settings, listed] = await Promise.all([
        ask("get_settings", claudeSettingsRequest),
        model === undefined ? null : ask("list_models", claudeListModelsRequest),
      ]);
      const judge = (field: string, value: string | undefined, refusal: (requested: string, answer: JsonRecord) => string | null): string | null => {
        if (value === undefined) {
          return null;
        }
        return settings instanceof Error ? `${settings.message}, so ${field} ${value} cannot be confirmed` : refusal(value, settings);
      };
      const refusals = [
        judge("model", model, (requested, answer) => claudeModelRefusal(requested, answer, listed ?? new Error("list_models was not asked"))),
        judge("effort", effort, claudeEffortRefusal),
      ].filter((refusal) => refusal !== null);
      return refusals.length > 0 ? refusals.join("; ") : null;
    },
  };
}
