import type { SessionOptions } from "../../contracts/session.js";
import { acpSession, type AcpSessionProfile } from "../../shared/acp/session.js";
import { asRecord, type JsonRecord } from "../../shared/json.js";

export function selectCursorAuthMethod(initialized: JsonRecord): string | undefined {
  const methods = Array.isArray(initialized.authMethods) ? initialized.authMethods : [];
  return methods
    .map((method) => asRecord(method))
    .some((method) => method?.id === "cursor_login")
    ? "cursor_login"
    : undefined;
}

/**
 * Without `parameterizedModelPicker` cursor-agent 2026.09.28 answers in its
 * "variants" picker mode: every model and effort pair is one flat `model`
 * value and no `thought_level` option exists. With it, `model` lists plain
 * model names and each model parameter is its own select option, the
 * reasoning one under category `thought_level`. Without `subagents` a child
 * is visible only as the parent's `task` tool call.
 */
export function cursorClientCapabilitiesMeta(): JsonRecord {
  return { parameterizedModelPicker: true, subagents: true };
}

/**
 * With the `subagents` opt-in cursor-agent 2026.09.28 announces each child on
 * the parent's own `session/update` (`subagent_spawned`, then
 * `subagent_state_update` with completed, failed, cancelled or disconnected),
 * and the child's standard updates arrive under its own session id.
 */
export const CURSOR_VENDOR_SESSION_UPDATES: readonly string[] = ["subagent_spawned", "subagent_state_update"];

function validateCursorOptions(options: SessionOptions): void {
  if (options.systemPrompt !== undefined || options.appendSystemPrompt !== undefined) {
    throw new Error("Cursor ACP does not expose a system prompt override");
  }
}

/**
 * `--force` (alias `--yolo`) is a root option, so it precedes the hidden
 * `acp` subcommand. It runs commands without asking; a team whose admin
 * controls auto run can still switch it off, and then the agent asks
 * through `session/request_permission`.
 */
export const cursorAcpArgs: readonly string[] = ["--force", "acp"];

/**
 * Requests cursor-agent 2026.09.28 sends its client beyond standard ACP. oar
 * implements none: each is recorded and refused with `-32601`, as an
 * unregistered method would be. On that refusal `cursor/ask_question` asks
 * one `session/request_permission` per single select question (oar picks its
 * first option), `cursor/create_plan` writes the plan to a local file, and
 * the rest were notices the agent does not wait on.
 */
export const CURSOR_EXTENSION_REQUESTS: readonly string[] = [
  "cursor/ask_question",
  "cursor/create_plan",
  "cursor/update_todos",
  "cursor/task",
  "cursor/generate_image",
];

export const cursorAcpProfile: AcpSessionProfile = {
  args: cursorAcpArgs,
  // Cursor's ACP method set has no steer. Subagents, once opted into, speak
  // under their own session ids (attribution tier #3,
  // docs/spec/attribution.md): recorded under those ids and linked to the
  // parent.
  capabilities: { steer: false, queue: { durable: false }, attribution: "nested" },
  requestTimeoutMs: 30_000,
  selectAuthMethod: selectCursorAuthMethod,
  validateOptions: validateCursorOptions,
  clientCapabilitiesMeta: cursorClientCapabilitiesMeta,
  // `session/set_model` answers `{}` and cursor never pushes
  // `config_option_update`, so only `set_config_option` reports the switch.
  modelViaConfigOption: true,
  extensionRequests: CURSOR_EXTENSION_REQUESTS,
  vendorSessionUpdates: CURSOR_VENDOR_SESSION_UPDATES,
};

export const cursorSession = acpSession(cursorAcpProfile);
