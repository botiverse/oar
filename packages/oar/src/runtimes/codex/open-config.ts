import type { SessionOptions } from "../../contracts/session.js";
import { asRecord, type JsonRecord } from "../../shared/json.js";
import type { AppServerClient } from "./app-server-client.js";
import { codexToolDenialsConfig, withCodexToolDenials } from "./tool-denials.js";

/** Resolve both options against the same native configuration for this open's cwd. */
export async function prepareCodexOpenParams(client: AppServerClient, options: SessionOptions, params: JsonRecord): Promise<JsonRecord> {
  const append = options.appendSystemPrompt;
  const filterTools = (options.disallowedTools?.length ?? 0) > 0;
  if (append === undefined && !filterTools) { return params; }
  const reply = await client.request("config/read", { cwd: options.cwd, includeLayers: false });
  const config = asRecord(reply.config);
  const filtered = filterTools ? withCodexToolDenials(params, codexToolDenialsConfig(options, config ?? {})) : params;
  if (append === undefined) { return filtered; }
  if (config === null) { throw new Error("codex config/read returned no effective configuration for appendSystemPrompt"); }
  const configured = config.developer_instructions;
  if (configured === null || configured === undefined || configured === "") { return filtered; }
  if (typeof configured !== "string") { throw new TypeError("codex config/read returned non-text developer_instructions"); }
  return { ...filtered, developerInstructions: append === "" ? configured : `${configured}\n\n${append}` };
}
