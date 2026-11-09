/* oxlint-disable typescript/no-unsafe-call, typescript/no-unsafe-member-access, typescript/no-unsafe-assignment, typescript/no-unsafe-argument -- Untyped raw ACP child-process fixture using a captured native error. */
import { readFileSync } from "node:fs";

const { error: refusal } = JSON.parse(readFileSync(new URL("../replay/fixtures/opencode-acp-v2-refusal.json", import.meta.url), "utf8"));
/** A synthetic named failure, or a captured steer refusal around the original prompt's native answer. */
export default function refusePrompt(request) {
  if (request.text === "named-failure") {
    request.error(request.id, -32_603, "Opaque provider refusal", { service: "Session", errorName: "provider.free-limit" });
    return true;
  }
  return refuseSteer(request);
}

function refuseSteer({ text, pending, id, result, error }) {
  if (text !== "refused-steer" && text !== "refused-steer-after-end") {
    return false;
  }
  if (text === "refused-steer-after-end") {
    for (const promptId of pending.keys()) {
      result(promptId, { stopReason: "end_turn" });
    }
    pending.clear();
  }
  setTimeout(() => { error(id, refusal.code, refusal.message, refusal.data); }, 40);
  return true;
}
