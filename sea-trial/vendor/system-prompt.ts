import assert from "node:assert/strict";
import type { LLMock } from "../harness/aimock.js";

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
 * Capture the system text of every provider request via a catch-all response
 * factory — the mock's journal caps bodies at 64KB and real harness requests
 * exceed it, so the factory (which sees the full normalized request) is the
 * reliable tap. The factory responds with `response` for every request.
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
 * Assert both mechanisms on the LATEST agent request: the replacement marker
 * present, the append marker present, and the runtime's own base prompt gone
 * (replace is a replace, not a prepend). Internal side-requests that run
 * their OWN prompts are skipped — pi's compaction summarizer ("context
 * summarization assistant") and claude's session-naming call ("naming a
 * coding session") are vendor facts, not agent prompts.
 */
export function assertSystemPrompt(systems: readonly string[], defaultToken: string): void {
  const last = systems.findLast((system) =>
    !system.includes("summarization assistant") && !system.includes("naming a coding session"));
  assert.ok(last !== undefined, "no agent request captured");
  assert.ok(last.includes(REPLACE_MARKER), `replacement marker missing; system head: ${last.slice(0, 200)}`);
  assert.ok(last.includes(APPEND_MARKER), `append marker missing; system head: ${last.slice(0, 200)}`);
  assert.ok(!last.includes(defaultToken), `runtime's default prompt still present ("${defaultToken}")`);
}
