/* oxlint-disable typescript/no-unsafe-assignment, typescript/no-unsafe-member-access, typescript/no-unsafe-call, typescript/no-unsafe-argument, eslint/no-underscore-dangle -- Standalone recorded wire fixture; `_meta` is ACP's native envelope. */
import fixture from "../replay/fixtures/grok-background-usage.json" with { type: "json" };

const stages = new Map();
// oxlint-disable-next-line eslint/max-statements -- One recorded prompt sequence, including duplicated wire delivery.
export default function grokBackgroundUsage(text, { send, result, requestId, promptId }) {
  const scenario = fixture.scenarios.find((entry) => `grok-${entry.scenario}` === text);
  if (!scenario) { return false; }
  const stage = (stages.get(text) ?? 0) + 1;
  stages.set(text, stage);
  // Grok uses the client's `_meta.promptId` (1.0.77); the recording predates
  // OAR naming its prompts, so its generated id is renamed to the request's.
  const recorded = scenario.frames.find((entry) => entry.stage === stage && entry.type === "session/prompt")?.native._meta.promptId;
  const frames = typeof promptId === "string" && typeof recorded === "string"
    ? JSON.parse(JSON.stringify(scenario.frames).replaceAll(recorded, promptId))
    : scenario.frames;
  for (const frame of frames.filter((entry) => entry.stage === stage)) {
    if (frame.type === "session/prompt") {
      result(requestId, frame.native);
    } else {
      send({ jsonrpc: "2.0", method: frame.type, params: frame.native });
      // An exact repeated delivery must not bill a second time, but remains a frame.
      send({ jsonrpc: "2.0", method: frame.type, params: frame.native });
    }
  }
  return true;
}

/** Historical root wake sent before the open answer, on the live method too. */
export function grokUsageHistory(mode, send) {
  if (mode !== "grok-usage-load" && mode !== "grok-usage-resume") { return; }
  const history = fixture.scenarios[1].frames.find((frame) => frame.native.update?.prompt_id?.startsWith("subagent-completed-") === true);
  send({ jsonrpc: "2.0", method: history.type, params: { ...history.native, _meta: { eventId: "historical-wake" } } });
}
