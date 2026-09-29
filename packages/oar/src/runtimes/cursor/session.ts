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
 * Without this opt-in cursor-agent 2026.09.28 answers in its "variants"
 * picker mode: every model and effort pair is one flat `model` value and no
 * `thought_level` option exists. With it, `model` lists plain model names and
 * each model parameter is its own select option, the reasoning one under
 * category `thought_level`.
 */
export function cursorClientCapabilitiesMeta(): JsonRecord {
  return { parameterizedModelPicker: true };
}

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
  // Cursor's ACP method set has no steer, and its subagent activity reaches
  // the transport only as the parent's tool calls: opaque.
  capabilities: { steer: false, queue: { durable: false }, attribution: "opaque" },
  requestTimeoutMs: 30_000,
  selectAuthMethod: selectCursorAuthMethod,
  validateOptions: validateCursorOptions,
  clientCapabilitiesMeta: cursorClientCapabilitiesMeta,
  // `session/set_model` answers `{}` and cursor never pushes
  // `config_option_update`, so only `set_config_option` reports the switch.
  modelViaConfigOption: true,
  extensionRequests: CURSOR_EXTENSION_REQUESTS,
};

export const cursorSession = acpSession(cursorAcpProfile);
