import { randomUUID } from "node:crypto";
import type { Frame, RequestRecord, ResponseBody } from "../../contracts/session.js";
import { asRecord, type JsonRecord } from "../../shared/json.js";
import type { CompactionOperation } from "../../shared/manual-compaction.js";
import type { LineProcess } from "../../shared/executable/index.js";
import { claudeControlResponseId } from "./effort.js";

type CommandSource = { builtin: boolean; revision: number } | { error: "unavailable" | "timeout" | "closed" };

export const CLAUDE_COMPACTION_BUSY = "Wait until the session is idle: a queued /compact can be reinterpreted as a project or user command before execution";

/** Command provenance is read in this process. Initialize also carries private account fields. */
export function claudeCompaction(child: LineProcess): {
  consume(message: JsonRecord): boolean;
  close(): void;
  create(this: void, send: (request: RequestRecord) => ResponseBody): CompactionOperation;
} {
  let revision = 0;
  const privateIds = new Set<string>();
  let pending: { id: string; resolve(value: CommandSource): void } | null = null;
  return {
    consume(message) {
      if (message.type === "system" && message.subtype === "commands_changed") { revision += 1; }
      const id = claudeControlResponseId(message);
      if (pending !== null && id === pending.id) {
        const response = asRecord(message.response);
        const commands = asRecord(response?.response)?.commands;
        pending.resolve(response?.subtype !== "success" ? { error: "unavailable" } : {
          builtin: Array.isArray(commands) && commands.some((value) => { const command = asRecord(value); return command?.name === "compact" && command.builtin === true; })
            && !commands.some((value) => { const command = asRecord(value); return command?.name === "compact" && command.builtin !== true; }),
          revision,
        });
      }
      return id !== null && privateIds.has(id);
    },
    close() { pending?.resolve({ error: "closed" }); },
    create(send) {
      let id: string | null = null;
      let checkedRevision: number | null = null;
      let started = false;
      let boundary: Frame | null = null;
      let failure: Frame | null = null;
      let changed = false;
      return {
        async start(request, reply) {
          const queryId = `oar-compact-source-${randomUUID()}`;
          const { promise, resolve } = Promise.withResolvers<CommandSource>();
          pending = { id: queryId, resolve };
          privateIds.add(queryId);
          // This bounds a read before dispatch, not the native compaction operation.
          const timer = setTimeout(() => { resolve({ error: "timeout" }); }, 10_000);
          try {
            child.write(`${JSON.stringify({ type: "control_request", request_id: queryId, request: { subtype: "initialize" } })}\n`);
            const source = await promise;
            if ("error" in source) {
              reply({ kind: "rejected", code: source.error === "closed" ? "disposed" : "runtime_refused", reason: `Claude command provenance query ${source.error}` });
              return;
            }
            if (!source.builtin || source.revision !== revision) {
              reply({ kind: "rejected", code: "unsupported", reason: "The current command catalog did not confirm an unchanged builtin compact command without a project/user override" });
              return;
            }
            checkedRevision = source.revision;
            id = request.id;
            reply(send(request));
          } finally { clearTimeout(timer); pending = null; }
        },
        observe(frame) {
          if (id === null) { return null; }
          if (frame.body.events.some((event) => event.kind === "input_dropped" && event.inputId === id && event.reason === "turn_interrupted")) { return { kind: "aborted", frame }; }
          const native = asRecord(frame.body.native);
          if (native?.type === "command_lifecycle" && native.command_uuid === id && native.state === "started") { started = true; }
          if (boundary === null && checkedRevision !== revision) { changed = true; }
          if (started && frame.body.events.some((event) => event.kind === "compaction_ended" && event.trigger === "manual")) { boundary = frame; }
          if (started && native?.type === "system" && native.subtype === "status" && native.compact_result === "failed") { failure = frame; }
          if (native?.type !== "result" || native.user_message_uuid !== id) { return null; }
          if (changed) { return { kind: "failed", code: "command_changed", reason: "Claude commands changed between provenance validation and the compaction boundary", frame }; }
          // The ordinary result can be success even when this native status reported failed compaction.
          if (failure !== null) { return { kind: "failed", code: "native_failed", reason: "Claude reported that compaction failed", frame: failure }; }
          if (native.is_error === true) {
            return { kind: "failed", code: "native_failed", reason: "Claude reported that the compact command failed", frame };
          }
          return boundary === null
            ? { kind: "failed", code: "not_compacted", reason: "The compact command ended without its native manual compact_boundary", frame }
            : { kind: "completed", frame: boundary };
        },
      };
    },
  };
}
