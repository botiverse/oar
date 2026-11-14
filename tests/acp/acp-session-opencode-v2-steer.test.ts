/* oxlint-disable max-statements -- Each case pins one native steering answer end to end. */
import { randomUUID } from "node:crypto";
import { expect, test } from "vitest";
import type { RawEvent, Session } from "../../packages/oar/src/contracts/session.js";
import { awaitTurnEnd, conversationOf } from "../../packages/oar/src/observe/index.js";
import { opencodeV2AcpProfile } from "../../packages/oar/src/runtimes/opencode/session.js";
import { acpSession } from "../../packages/oar/src/shared/acp/session.js";
import { fixture } from "../fixtures/acp-session-support.js";

/** A v2 agent whose `initialize` advertises `_session/steering` (fake-acp-opencode-steering.mjs). */
async function steering(): Promise<Session> {
  return acpSession({ ...opencodeV2AcpProfile, args: [fixture, "opencode-steering"] })(
    { kind: "available", via: "executable", command: process.execPath }, { cwd: process.cwd() },
  );
}
const events = (records: readonly RawEvent[]) => records.flatMap((record) => record.kind === "frame" ? record.body.events : []);
const texts = (records: readonly RawEvent[]) => events(records).flatMap((event) => event.kind === "text_delta" ? [event.text] : []);
const steeringFrames = (records: readonly RawEvent[]) => records.flatMap((record) => record.kind === "frame" && record.body.type.startsWith("_session/steering") ? [record] : []);
const requests = (records: readonly RawEvent[]) => records.flatMap((record) => record.kind === "request" ? [record.body.kind] : []);

test("an advertised steering extension gives v2 `steer`; an injected steer joins the running turn, which ends once", async () => {
  const session = await steering();
  try {
    expect(typeof session.steer).toBe("function");
    const started = await session.prompt("hold");
    const steerId = randomUUID();
    const steered = await session.steer?.("also this", { inputId: steerId });
    expect(steered).toMatchObject({ kind: "accepted" });
    const viaHelper = await session.steerOrQueue("and this");
    const delivered = await session.deliver("steer-and-finish");
    expect([viaHelper.landed, delivered.landed]).toEqual(["steered", "steered"]);
    await awaitTurnEnd(session, started.seq);
    const records = session.records();
    const frames = steeringFrames(records);
    expect(frames.map((frame) => [frame.body.native, frame.body.events])).toEqual([
      [{ outcome: "injected" }, []], [{ outcome: "injected" }, []], [{ outcome: "injected" }, []],
    ]);
    expect(frames[0]?.body.responseTo).toBe(steered?.requestId);
    expect(requests(records)).toEqual(["open", "prompt", "steer", "steer", "steer"]);
    expect(texts(records)).toEqual(["steered:also this", "steered:and this", "steered:steer-and-finish"]);
    expect(events(records).filter((event) => event.kind === "turn_ended")).toEqual([{ kind: "turn_ended", outcome: { kind: "completed" } }]);
    expect([...conversationOf(records).inputs.values()].find((input) => input.inputId === steerId)).toMatchObject({ input: "also this", state: "accepted" });
  } finally { await session.dispose(); }
});

test("promptRequired is `no_active_turn`: the answer is recorded, nothing starts, and the helpers queue for the next turn", async () => {
  const session = await steering();
  try {
    // OAR's prompt is still unanswered, but the native turn already ended.
    await session.prompt("hold-idle");
    expect(await session.steer?.("too late")).toMatchObject({ kind: "rejected", code: "no_active_turn" });
    const viaHelper = await session.steerOrQueue("queued-one");
    const delivered = await session.deliver("queued-two");
    expect([viaHelper.landed, delivered.landed]).toEqual(["queued", "queued"]);
    expect(steeringFrames(session.records()).map((frame) => frame.body.native)).toEqual([
      { outcome: "promptRequired", reason: "noRunningTurn" },
      { outcome: "promptRequired", reason: "noRunningTurn" },
      { outcome: "promptRequired", reason: "noRunningTurn" },
    ]);
    await session.abort();
    await expect.poll(() => texts(session.records())).toEqual(["echo:queued-one", "echo:queued-two"]);
  } finally { await session.dispose(); }
});

test("an idle session sends no steering request", async () => {
  const session = await steering();
  try {
    expect(await session.steer?.("nothing running")).toMatchObject({ kind: "rejected", code: "no_active_turn" });
    expect(steeringFrames(session.records())).toEqual([]);
  } finally { await session.dispose(); }
});

test("a steering RPC error is the runtime's refusal, retained as its error frame; an unknown outcome is not claimed as delivered", async () => {
  const session = await steering();
  try {
    await session.prompt("hold");
    expect(await session.steer?.("steer-error")).toMatchObject({ kind: "rejected", code: "runtime_refused" });
    expect(await session.steer?.("steer-unknown")).toMatchObject({ kind: "rejected", code: "error" });
    expect(steeringFrames(session.records()).map((frame) => frame.body.type)).toEqual(["_session/steering/error", "_session/steering"]);
    expect(events(session.records()).some((event) => event.kind === "turn_ended")).toBe(false);
    await session.abort();
  } finally { await session.dispose(); }
});
