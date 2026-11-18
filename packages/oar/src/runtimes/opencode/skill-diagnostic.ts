import { sessionCredentialRedactor } from "../../shared/credential-redactor.js";
import { stripTerminalEscapes } from "../../shared/login.js";
import { redactTokenShapes } from "../../shared/token-redaction.js";

const EXCERPT_LIMIT = 500;

/** Sanitize before truncating so a cut cannot reveal the start of a credential. */
export function skillFailureReason(exitCode: number | null, stderr: string, env: NodeJS.ProcessEnv, invalidBytes?: number): string {
  const redactor = sessionCredentialRedactor({ env: Object.fromEntries(Object.entries(env).map(([key, value]) => [key, value ?? null])) });
  let text = stderr;
  for (const value of redactor.values()) {
    for (const encoded of [value, JSON.stringify(value).slice(1, -1), encodeURIComponent(value)]) {
      text = text.replaceAll(encoded, "[redacted]");
    }
  }
  text = redactTokenShapes(stripTerminalEscapes(text))
    .replaceAll(/\b(?:gh[pousr]_|github_pat_|AIza|ya29\.)[\w.-]+/gu, "[redacted]")
    .replaceAll(/\b(?:Bearer|Basic)\s+[\w+/=.-]+/giu, "[redacted authorization]")
    .replaceAll(/\b[a-z][a-z\d+.-]*:\/\/[^\s<>"']+/giu, "[redacted URL]")
    .replaceAll(/\b([\w.-]*(?:key|token|secret|password|passwd|credential)s?|authorization|proxy-authorization|(?:set-)?cookie)["']?\s*[:=][^\r\n]*/giu, "$1=[redacted]");
  const line = text.split(/[\r\n]/u).find(part => part.trim() !== "")?.trim() ?? "";
  const excerpt = line.length > EXCERPT_LIMIT ? `${line.slice(0, EXCERPT_LIMIT)}...` : line;
  const status = exitCode === null ? "no exit code" : `exit ${String(exitCode)}`;
  const output = invalidBytes === undefined ? "" : (invalidBytes === 0 ? "; no output" : `; output was not valid JSON or a skill catalog (${String(invalidBytes)} bytes, truncated?)`);
  return `OpenCode skill discovery failed (${status}${output})${excerpt === "" ? "" : `: ${excerpt}`}`;
}
