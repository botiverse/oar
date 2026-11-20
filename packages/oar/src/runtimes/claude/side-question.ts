import { randomUUID } from "node:crypto";
import type { AvailableInstallation, SideQuestionOptions } from "../../contracts/index.js";
import { rememberEnvironmentCredentials, sessionCredentialRedactor } from "../../shared/credential-redactor.js";
import { runExecutable } from "../../shared/executable/run.js";
import { asRecord, parseJson } from "../../shared/json.js";
import { semverAtLeast } from "../../shared/semver.js";
import { claudeCredentials } from "./credentials.js";
import { claudeEnv } from "./environment.js";

export function supportsClaudeSideQuestion(installation: AvailableInstallation): boolean {
  return installation.via === "executable" && semverAtLeast(installation.version, "2.1.326");
}

export async function claudeSideQuestion(installation: AvailableInstallation, options: SideQuestionOptions): Promise<string> {
  if (installation.via !== "executable" || !supportsClaudeSideQuestion(installation)) {
    throw new Error("Claude side questions require a verified executable from 2.1.326");
  }
  if (!/^[\da-f]{8}(?:-[\da-f]{4}){3}-[\da-f]{12}$/iu.test(options.sessionId)) { throw new TypeError("A native Claude session UUID is required"); }
  if (typeof options.question !== "string" || options.question.length === 0) { throw new TypeError("A side question requires text"); }
  const timeoutMs = options.timeoutMs ?? 60_000;
  if (!Number.isSafeInteger(timeoutMs) || timeoutMs <= 0 || timeoutMs > 2_147_483_647) { throw new RangeError("timeoutMs must be a positive timer duration"); }
  options.signal?.throwIfAborted();
  const fork = randomUUID();
  const env = claudeEnv({ ...options.env, ENABLE_CLAUDEAI_MCP_SERVERS: "false" });
  const clean = sessionCredentialRedactor(options.env === undefined ? {} : { env: options.env });
  rememberEnvironmentCredentials(clean, env, (claudeCredentials.env ?? []).filter(variable => variable.secret).map(variable => variable.name));
  const result = await runExecutable(installation.command, [
    "--print", "--output-format", "json", "--resume", options.sessionId, "--fork-session", "--session-id", fork,
    "--no-session-persistence", "--tools", "", "--strict-mcp-config", "--mcp-config", '{"mcpServers":{}}',
    "--settings", '{"disableAllHooks":true}', "--disable-slash-commands",
    ...(options.model === undefined ? [] : ["--model", options.model]),
  ], { cwd: options.cwd, env, input: options.question, timeoutMs, ...(options.signal === undefined ? {} : { signal: options.signal }) });
  options.signal?.throwIfAborted();
  if (result.diagnostics?.timeoutMs !== undefined) { throw new DOMException("Claude side question timed out", "TimeoutError"); }
  const reply = asRecord(parseJson(result.stdout));
  if (!result.ok || reply?.type !== "result" || reply.subtype !== "success" || reply.is_error !== false) {
    const code = result.exitCode === null ? "" : ` (exit code ${result.exitCode})`;
    throw new Error(`Claude did not return a successful side answer${code}`);
  }
  if (reply.session_id !== fork || typeof reply.result !== "string") { throw new Error("Claude returned no answer attributed to the requested fork"); }
  return clean.redact(reply.result);
}
