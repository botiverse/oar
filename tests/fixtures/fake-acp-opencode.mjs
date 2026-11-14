/* oxlint-disable eslint/max-statements, unicorn/numeric-separators-style, typescript/no-unsafe-assignment, typescript/no-unsafe-member-access, typescript/no-unsafe-call, typescript/no-unsafe-argument -- Untyped raw ACP fixture helper. */

/** OpenCode v1 (mode "opencode"): a mid-turn prompt joins the held loop and every answer arrives at idle. */
export function mergedOpencodePrompt(mode, { text, message, pendingPrompts, update, result }) {
  if (mode !== "opencode" || pendingPrompts.size === 0) { return false; }
  update({ sessionUpdate: "agent_message_chunk", content: { type: "text", text: `merged:${[...pendingPrompts.values(), text].join("+")}` } });
  for (const id of [...pendingPrompts.keys(), message.id]) {
    update({ sessionUpdate: "usage_update", used: 300, size: 1000 });
    result(id, { stopReason: "end_turn" });
  }
  pendingPrompts.clear();
  return true;
}

/** OpenCode v2 (mode "opencode-steering"): `initialize` advertises `_session/steering` (2.2.7 and later). */
export function opencodeSteeringMeta(mode) {
  return mode === "opencode-steering" ? { _meta: { steering: { supported: true } } } : {};
}

/**
 * `_session/steering` (`packages/cli/src/acp/turn.ts` `steer`). A held "hold"
 * prompt is a running native turn: the steer is injected, and after the steer
 * "steer-and-finish" the turn ends with the original prompt's answer. A held
 * "hold-idle" prompt models a native turn that already ended before its
 * prompt answered, so the agent reports `promptRequired` and starts nothing.
 * The text "steer-error" is answered with a JSON-RPC error, "steer-unknown"
 * with an outcome OAR does not know. Returns whether it answered.
 */
export function opencodeSteering(mode, message, { pendingPrompts, send, result, error }) {
  if (mode !== "opencode-steering" || message.method !== "_session/steering") { return false; }
  const block = Array.isArray(message.params?.prompt) ? message.params.prompt.find((part) => part?.type === "text") : undefined;
  const text = typeof block?.text === "string" ? block.text : "";
  const running = [...pendingPrompts.entries()].filter(([, held]) => held === "hold");
  if (text === "steer-error") { error(message.id, -32603, "steering failed"); }
  else if (text === "steer-unknown") { result(message.id, { outcome: "deferred" }); }
  else if (running.length === 0) { result(message.id, { outcome: "promptRequired", reason: "noRunningTurn" }); }
  else {
    send({ jsonrpc: "2.0", method: "session/update", params: { sessionId: message.params.sessionId, update: { sessionUpdate: "agent_message_chunk", content: { type: "text", text: `steered:${text}` } } } });
    result(message.id, { outcome: "injected" });
    if (text === "steer-and-finish") {
      queueMicrotask(() => { for (const [id] of running) { pendingPrompts.delete(id); result(id, { stopReason: "end_turn" }); } });
    }
  }
  return true;
}
