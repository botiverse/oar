/* oxlint-disable eslint/max-statements, typescript/no-unsafe-assignment, typescript/no-unsafe-member-access, typescript/no-unsafe-call, typescript/no-unsafe-argument, import/no-nodejs-modules, unicorn/numeric-separators-style -- Raw ACP fake for the measured early-answer lifecycle. */
import { existsSync, readFileSync } from "node:fs";

export default function replacingPrompt(text, message, { pendingPrompts, result, error }) {
  if (text === "agy-refused-steer") { error(message.id, -32602, "Invalid params: image is empty"); return true; }
  if (text === "agy-steer-pending" || text === "agy-original-held") {
    if (text === "agy-steer-pending") {
      // Native 1.5.0 acknowledges the prior prompt while the loop continues.
      for (const id of pendingPrompts.keys()) { result(id, { stopReason: "end_turn" }); }
      pendingPrompts.clear();
    }
    pendingPrompts.set(message.id, text);
    const timer = setInterval(() => {
      if (pendingPrompts.has(message.id) !== true) { clearInterval(timer); return; }
      const gate = process.env.FAKE_ACP_STEER_FINISH;
      if (typeof gate !== "string" || gate === "" || existsSync(gate) !== true) { return; }
      pendingPrompts.delete(message.id);
      clearInterval(timer);
      if (readFileSync(gate, "utf8") === "error") { error(message.id, -32603, "replacement prompt failed"); }
      else { result(message.id, { stopReason: "end_turn" }); }
    }, 10);
    return true;
  }
  return false;
}
