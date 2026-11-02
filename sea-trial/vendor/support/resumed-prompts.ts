import assert from "node:assert/strict";
import type { LLMock } from "@copilotkit/aimock";
import type { ResumeOptionSemantics, Runtime } from "../../../packages/oar/src/contracts/runtime.js";
import { asRecord } from "../../../packages/oar/src/shared/json.js";
import type { RawProviderRequest } from "../../harness/aimock.js";

export const promptKeys = ["systemPrompt", "appendSystemPrompt"] as const;
export type PromptKey = typeof promptKeys[number];
export const oldPrompts = { systemPrompt: "OAR_OLD_REPLACEMENT_7319", appendSystemPrompt: "OAR_OLD_APPEND_8420" };
export const newPrompts = { systemPrompt: "OAR_NEW_REPLACEMENT_9531", appendSystemPrompt: "OAR_NEW_APPEND_0642" };
export const promptMarkers = [...Object.values(oldPrompts), ...Object.values(newPrompts)];

/** Expectations come from the public declaration, so a native change fails its contract. */
export function promptSemantics(runtime: Runtime, key: PromptKey): ResumeOptionSemantics {
  const semantics = runtime.resumedSessionOptions?.[key];
  assert.ok(semantics !== undefined, `${runtime.id}.${key} needs a measured resume declaration`);
  return semantics;
}

export function resumedMarker(semantics: ResumeOptionSemantics, state: { readonly saved: string | undefined; readonly provided: string | undefined }, compacted: boolean): string[] {
  const value = state.provided !== undefined
    ? (semantics.provided === "immediate" || compacted ? state.provided : state.saved)
    : (semantics.omitted === "saved" || (semantics.omitted === "saved_until_compaction" && !compacted) ? state.saved : undefined);
  return value === undefined ? [] : [value];
}

/** Only native summarization requests receive a marker; normal turns never do. */
export function resumeCompaction(): { readonly summaries: string[]; readonly arm: () => void; readonly configure: (mock: LLMock) => void } {
  let largeUsage = false;
  const summaries: string[] = [];
  return {
    summaries,
    arm: (): void => { largeUsage = true; },
    configure: (mock: LLMock): void => {
      mock.onMessage(/[\s\S]*/u, (request) => {
        const system = JSON.stringify(request.messages.filter((message) => message.role === "system"));
        const lastUser = JSON.stringify(request.messages.findLast((message) => message.role === "user")?.content ?? "");
        if (system.includes("You are a context summarization assistant.") || system.includes("You are the component that summarizes a conversation") || lastUser.includes("Then, produce the <state_snapshot> XML.")) {
          const marker = `OAR_RESUME_COMPACT_SUMMARY_${String(summaries.length + 1)}_7264`;
          summaries.push(marker);
          return { content: `<state_snapshot><primary_request_and_intent>${marker} The user is testing native prompt persistence across resume and compaction.</primary_request_and_intent><key_technical_concepts>Local scripted provider, saved conversation, supplied and omitted prompt settings.</key_technical_concepts><current_state>The prior scripted exchanges completed. Continue with the next user input and preserve the current session configuration.</current_state></state_snapshot>`, usage: { input_tokens: 20_000, output_tokens: 100 } };
        }
        const raised = largeUsage && lastUser.includes("OAR_RESUME_RAISE_USAGE_");
        const tokens = raised ? 90_000 : 100;
        if (raised) { largeUsage = false; }
        return { content: `An ordinary response. ${"The local prompt persistence control completed without using tools. ".repeat(100)}`, usage: { input_tokens: tokens, output_tokens: 400 } };
      });
    },
  };
}

/** Select by the last user input, never by the system markers being tested. */
export function requestsForTurn(requests: readonly RawProviderRequest[], input: string): { readonly system: string; readonly history: string }[] {
  return requests.flatMap(({ body }) => {
    const request = asRecord(body);
    const rawMessages = request?.messages ?? request?.input;
    const messages = Array.isArray(rawMessages) ? rawMessages.map((message: unknown) => asRecord(message)) : [];
    // Memory extraction, naming and compaction may include saved conversation
    // messages, but their final user message is not this main turn's input.
    const content = messages.findLast((message) => message?.role === "user")?.content;
    const texts = typeof content === "string" ? [content] : (Array.isArray(content) ? content.map((part) => asRecord(part)?.text) : []);
    if (!texts.includes(input)) { return []; }
    return [{
      system: JSON.stringify([request?.system, request?.instructions, ...messages.filter((message) => message?.role === "system" || message?.role === "developer")]),
      history: JSON.stringify(messages.filter((message) => message?.role === "user" || message?.role === "assistant")),
    }];
  });
}
