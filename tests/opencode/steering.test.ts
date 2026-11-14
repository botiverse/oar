import { expect, test } from "vitest";
import { opencodeAcpProfile, opencodeBackgroundChildProfile, opencodeV2AcpProfile } from "../../packages/oar/src/runtimes/opencode/session.js";
import { asRecord } from "../../packages/oar/src/shared/json.js";
import { wireOf } from "../fixtures/opencode-background-replay.js";

/** The native 2.3.0 `initialize` answer recorded in experiments/opencode-child-background/enabled.json. */
function recordedInitialize(): Record<string, unknown> {
  const answer = wireOf("enabled.json").find(({ direction, message }) => direction === undefined && message.id === 0);
  const result = asRecord(answer?.message.result);
  if (result === null) { throw new Error("no recorded initialize answer"); }
  return result;
}

test("v2 gates `_session/steering` on the advertised capability, not a version", () => {
  const initialized = recordedInitialize();
  expect(initialized).toMatchObject({ _meta: { steering: { supported: true } } });
  expect(asRecord(initialized.agentInfo)?.version).toBe("2.3.0");
  for (const profile of [opencodeV2AcpProfile, opencodeBackgroundChildProfile]) {
    expect(profile.steerRequestAdvertised?.(initialized)).toBe(true);
    // 2.2.6 and earlier answer without the top-level `_meta`.
    const older = Object.fromEntries(Object.entries(initialized).filter(([key]) => key !== "_meta"));
    expect(profile.steerRequestAdvertised?.(older)).toBe(false);
    expect(profile.steerRequestAdvertised?.({ ...older, _meta: { steering: { supported: false } } })).toBe(false);
  }
  // v1 steers with a second prompt and has no steering extension.
  expect([opencodeAcpProfile.steerRequest, opencodeAcpProfile.steerParams === undefined]).toEqual([undefined, false]);
});

test("v2 sends the ACP prompt blocks and reads only the two documented outcomes", () => {
  const prompt = [{ type: "text", text: "also this" }];
  expect(opencodeV2AcpProfile.steerRequest?.({ sessionId: "ses_1", input: "also this", prompt, inputId: "id-1" }))
    .toEqual({ method: "_session/steering", params: { sessionId: "ses_1", prompt } });
  const read = opencodeV2AcpProfile.steerRequestAnswer;
  expect([
    read?.({ outcome: "injected" }),
    read?.({ outcome: "promptRequired", reason: "noRunningTurn" }),
    read?.({ outcome: "queued" }),
    read?.(null),
  ]).toEqual(["accepted", "no_active_turn", null, null]);
});
