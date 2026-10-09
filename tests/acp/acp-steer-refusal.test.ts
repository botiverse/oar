/* oxlint-disable eslint/max-statements, eslint/max-lines-per-function -- Each test follows one ordered control/notification exchange. */
import { expect, test } from "vitest";
import type { Session } from "../../packages/oar/src/contracts/session.js";
import { opencodeAcpProfile } from "../../packages/oar/src/runtimes/opencode/session.js";
import { acpSession } from "../../packages/oar/src/shared/acp/session.js";
import { conversationOf } from "../../packages/oar/src/observe/conversation.js";
import { awaitTurnEnd } from "../../packages/oar/src/observe/turns.js";
import { fixture, profile } from "../fixtures/acp-session-support.js";

const inputId = "21785c6a-0777-49b2-a985-8cfe2ef441a3";
const opencode = { ...opencodeAcpProfile, args: [fixture, "opencode"] };
function frames(session: Session) {
  return session.records().flatMap((record) => record.kind === "frame" ? [record.body] : []);
}
function droppedInput(session: Session) {
  const input = [...conversationOf(session.records()).inputs.values()].find((value) => value.inputId === inputId);
  return { state: input?.state, reason: input?.reason, attempts: input?.attempts.map((attempt) => attempt.state) };
}

for (const [name, selected, next] of [
  ["opencode v1", opencode, "more"],
  ["send-now", profile({ steerSupersedesPrompt: true, steerParams: () => ({ _meta: { sendNow: true } }) }), "steer-new"],
] as const) {
  for (const afterEnd of [false, true]) {
    test(`${name}: refused steer ${afterEnd ? "after" : "before"} the prompt answer cannot fail the turn`, async () => {
      const session = await acpSession(selected)(
        { kind: "available", via: "executable", command: process.execPath },
        { cwd: process.cwd() },
      );
      try {
        const prompt = await session.prompt("hold");
        const steered = await session.steer?.(afterEnd ? "refused-steer-after-end" : "refused-steer", { inputId });
        expect(steered?.kind).toBe("accepted");
        await expect.poll(() => droppedInput(session).state).toBe("dropped");
        expect(droppedInput(session)).toMatchInlineSnapshot(`
          {
            "attempts": [
              "accepted",
            ],
            "reason": "runtime_refused",
            "state": "dropped",
          }
        `);
        expect(frames(session).find((frame) => frame.type === "session/prompt/error")?.native).toMatchInlineSnapshot(`
          {
            "code": -32603,
            "data": {
              "service": "session",
            },
            "message": "Internal error: Session already has an active ACP prompt: fake-session",
            "name": "RequestError",
          }
        `);
        // The original RPC answer was preserved, whichever one arrived first.
        expect(frames(session).some((frame) => frame.type === "session/prompt")).toBe(afterEnd);
        if (!afterEnd) {
          expect(session.status().value.kind).toBe("running");
          const continued = await session.steer?.(next);
          expect(continued?.kind).toBe("accepted");
        }
        expect(await awaitTurnEnd(session, prompt.seq)).toMatchInlineSnapshot(`
          {
            "kind": "completed",
          }
        `);
        expect(frames(session).flatMap((frame) => frame.events).filter((event) => event.kind === "turn_ended")).toMatchInlineSnapshot(`
          [
            {
              "kind": "turn_ended",
              "outcome": {
                "kind": "completed",
              },
            },
          ]
        `);
      } finally {
        await session.dispose();
      }
    });
  }
}

test("a refused v1 steer arriving during the next turn cannot finish or fail that turn", async () => {
  const session = await acpSession(opencode)(
    { kind: "available", via: "executable", command: process.execPath }, { cwd: process.cwd() },
  );
  try {
    const first = await session.prompt("hold");
    await session.steer?.("refused-steer-after-end", { inputId });
    expect(await awaitTurnEnd(session, first.seq)).toMatchInlineSnapshot(`
      {
        "kind": "completed",
      }
    `);
    const second = await session.prompt("hold");
    await expect.poll(() => droppedInput(session).state).toBe("dropped");
    expect(session.status().value.kind).toBe("running");
    expect(frames(session).flatMap((frame) => frame.events).filter((event) => event.kind === "turn_ended")).toHaveLength(1);
    // A dropped input is owned by the host again and can reuse its input ID.
    const retry = await session.steer?.("more", { inputId });
    expect(retry?.kind).toBe("accepted");
    expect(await awaitTurnEnd(session, second.seq)).toMatchInlineSnapshot(`
      {
        "kind": "completed",
      }
    `);
    expect(droppedInput(session)).toMatchInlineSnapshot(`
      {
        "attempts": [
          "accepted",
          "accepted",
        ],
        "reason": undefined,
        "state": "accepted",
      }
    `);
  } finally {
    await session.dispose();
  }
});
