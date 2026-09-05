import { randomUUID } from "node:crypto";
import type { ModelEntry, ModelLister } from "../../contracts/list-models.js";
import { effortLevelsOf } from "../../shared/effort-levels.js";
import { spawnLineProcess } from "../../shared/executable/index.js";
import { asRecord, asRecordList, parseJson, type JsonRecord } from "../../shared/json.js";

type ReadOutcome =
  | { readonly kind: "ok"; readonly payload: unknown }
  | { readonly kind: "unauthenticated"; readonly detail: string }
  | { readonly kind: "error"; readonly detail: string };

function text(value: unknown): string | undefined {
  if (typeof value !== "string") {
    return undefined;
  }
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : undefined;
}

/**
 * Project the `list_models` control response. `value` is the selector the
 * session accepts (an alias such as `sonnet` or a concrete ID); `resolvedModel`
 * is what that alias means today. A `disabled` entry is still listed because
 * claude shows it, with its description as the reason (typically a required
 * CLI upgrade).
 */
export function projectClaudeModels(payload: unknown): ModelEntry[] {
  const models = asRecordList(asRecord(payload)?.models);
  const entries: ModelEntry[] = [];
  for (const model of models) {
    const id = text(model.value);
    if (id === undefined) {
      continue;
    }
    const resolvedId = text(model.resolvedModel);
    const displayName = text(model.displayName);
    const effortLevels = effortLevelsOf(model.supportedEffortLevels);
    const reason = text(model.description) ?? "disabled by claude";
    entries.push({
      id,
      ...(resolvedId === undefined ? {} : { resolvedId }),
      ...(displayName === undefined ? {} : { displayName }),
      ...(effortLevels === undefined ? {} : { effortLevels }),
      ...(model.disabled === true ? { disabled: { reason } } : {}),
    });
  }
  return entries;
}

function controlError(inner: JsonRecord): string {
  return text(inner.error) ?? text(inner.message) ?? "claude rejected the list_models control request";
}

/**
 * Claude answers `list_models` on the stream-json control channel before any
 * turn runs, so this costs no tokens. `--verbose` is mandatory for stream-json
 * output in print mode. Matching is by `request_id`; other control traffic
 * (for example hooks or permission prompts) is ignored.
 */
async function readListModels(command: string, timeoutMs: number): Promise<ReadOutcome> {
  const child = spawnLineProcess(command, [
    "-p",
    "--input-format", "stream-json",
    "--output-format", "stream-json",
    "--verbose",
  ], { env: { ...process.env, CLAUDECODE: undefined } });
  const requestId = `oar-list-models-${randomUUID()}`;
  const { promise: answered, resolve } = Promise.withResolvers<JsonRecord | null>();
  child.onLine((line) => {
    const message = asRecord(parseJson(line));
    if (message?.type !== "control_response") {
      return;
    }
    const inner = asRecord(message.response);
    if (inner?.request_id === requestId) {
      resolve(inner);
    }
  });
  child.onExit(() => {
    resolve(null);
  });
  const timer = setTimeout(() => {
    child.kill();
  }, timeoutMs);
  try {
    await child.spawned;
    child.write(`${JSON.stringify({
      type: "control_request",
      request_id: requestId,
      request: { subtype: "list_models" },
    })}\n`);
    const inner = await answered;
    if (inner === null) {
      return { kind: "error", detail: "claude exited before answering list_models" };
    }
    if (inner.subtype === "success") {
      return { kind: "ok", payload: inner.response };
    }
    const detail = controlError(inner);
    if (/log(?:ged)? ?in|auth|api key/iu.test(detail)) {
      return { kind: "unauthenticated", detail };
    }
    return { kind: "error", detail };
  } finally {
    clearTimeout(timer);
    child.kill();
    await child.exited;
  }
}

async function readOutcome(command: string, timeoutMs: number): Promise<ReadOutcome> {
  try {
    return await readListModels(command, timeoutMs);
  } catch (error) {
    throw new Error("Failed to list Claude models", { cause: error });
  }
}

export const claudeListModels: ModelLister = async (installation, options = {}) => {
  if (installation.via !== "executable") {
    return { kind: "unsupported", reason: "claude model listing requires the claude executable" };
  }
  const outcome = await readOutcome(installation.command, options.timeoutMs ?? 15_000);
  if (outcome.kind === "ok") {
    return { kind: "ok", models: projectClaudeModels(outcome.payload) };
  }
  if (outcome.kind === "unauthenticated") {
    return { kind: "unauthenticated", detail: outcome.detail };
  }
  throw new Error(`Failed to list Claude models: ${outcome.detail}`);
};
