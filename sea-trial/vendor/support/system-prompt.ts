import assert from "node:assert/strict";
import { tmpdir } from "node:os";
import type { LLMock } from "../../harness/aimock.js";

export const REPLACE_MARKER = "OAR-SYSTEM-REPLACE-MARKER";
export const APPEND_MARKER = "OAR-SYSTEM-APPEND-MARKER";

interface NormalizedRequest {
  readonly messages?: readonly { readonly role: string; readonly content: unknown }[];
  readonly system?: unknown;
}

function systemTextOf(request: NormalizedRequest): string {
  const fromMessages = (request.messages ?? [])
    .filter((message) => message.role === "system" || message.role === "developer")
    .map((message) => (typeof message.content === "string" ? message.content : JSON.stringify(message.content)));
  const system = request.system;
  const fromField = typeof system === "string"
    ? [system]
    : (Array.isArray(system) ? system.map((block: unknown) => JSON.stringify(block)) : []);
  return [...fromField, ...fromMessages].join("\n");
}

/**
 * Record the system text of every provider request, via a catch-all response
 * fixture written as a function: aimock calls it per request with the
 * NORMALIZED request object, we note the system text and return `response`.
 * (Reading the journal instead would hit raw per-API shapes and its 64KB
 * body cap.)
 */
export function systemCapture(response?: Record<string, unknown>): {
  readonly systems: string[];
  readonly configure: (mock: LLMock) => void;
} {
  const systems: string[] = [];
  const reply = response ?? { content: "ok" };
  return {
    systems,
    configure: (mock) => {
      mock.onMessage(/[\s\S]*/u, (request: NormalizedRequest) => {
        systems.push(systemTextOf(request));
        return reply;
      });
    },
  };
}

/**
 * The LATEST agent request's system text. Internal side-requests that run
 * their OWN prompts are skipped — pi's compaction summarizer ("context
 * summarization assistant") and claude's session-naming call ("naming a
 * coding session") are vendor facts, not agent prompts.
 */
export function lastAgentSystem(systems: readonly string[]): string {
  const last = systems.findLast((system) =>
    !system.includes("summarization assistant") && !system.includes("naming a coding session"));
  assert.ok(last !== undefined, "no agent request captured");
  return last;
}

/**
 * Make a replaced system prompt inline-snapshot-stable: mask what varies by
 * machine or vendor RELEASE (temp dirs, cwd, versions, codex's skill catalog,
 * pi's embedded context-file bodies) while keeping the full structure — where
 * the replacement lands, where the append lands, and every fixed harness
 * addition around them.
 */
export function scrubSystem(system: string): string {
  const cwd = process.cwd();
  const temp = tmpdir();
  let scrubbed = system.replaceAll("\r\n", "\n").replaceAll("\r", "\n");
  // Both slash spellings of cwd/tmp appear on Windows.
  for (const [root, mask] of [[cwd, "<CWD>"], [temp, "<TMPDIR>"]] as const) {
    scrubbed = scrubbed
      .replaceAll(root, mask)
      .replaceAll(root.replaceAll("\\", "/"), mask)
      .replaceAll(root.replaceAll("/", "\\"), mask);
  }
  return scrubbed
    .replaceAll(/(<CWD>|<TMPDIR>)\\+/gu, "$1/")
    .replaceAll(/cc_version=[^;]+/gu, "cc_version=<VERSION>")
    .replaceAll(/\/tmp\/[\w-]+/gu, "<TMPDIR>")
    .replaceAll(/oar-(\w+)-aimock-\w+/gu, "oar-$1-aimock-<RAND>")
    .replace(/<skills_instructions>[\s\S]*?<\/skills_instructions>/u, "<skills_instructions>…(version-dependent skill catalog scrubbed)…</skills_instructions>")
    .replaceAll(/<project_instructions path="([^"]+)">[\s\S]*?<\/project_instructions>/gu, '<project_instructions path="$1">…(file body scrubbed)…</project_instructions>');
}
