import assert from "node:assert/strict";
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

export function resumedMarker(semantics: ResumeOptionSemantics, key: PromptKey, provided: boolean, compacted = false): string[] {
  if (provided) { return [semantics.provided === "immediate" || compacted ? newPrompts[key] : oldPrompts[key]]; }
  return semantics.omitted === "saved" || (semantics.omitted === "saved_until_compaction" && !compacted) ? [oldPrompts[key]] : [];
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
