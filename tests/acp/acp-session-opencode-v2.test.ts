/* oxlint-disable eslint/max-statements -- One control exchange verifies absent steer and both fallback helpers. */
import { expect, test } from "vitest";
import { opencodeV2AcpProfile } from "../../packages/oar/src/runtimes/opencode/session.js";
import { acpSession } from "../../packages/oar/src/shared/acp/session.js";
import { fixture } from "../fixtures/acp-session-support.js";

test("v2 omits steer; steerOrQueue and deliver both hold input for subsequent turns", async () => {
  const session = await acpSession({ ...opencodeV2AcpProfile, args: [fixture, "opencode"] })(
    { kind: "available", via: "executable", command: process.execPath }, { cwd: process.cwd() },
  );
  try {
    expect(Object.hasOwn(session, "steer")).toBe(false);
    expect(session.capabilities).toMatchInlineSnapshot(`
      {
        "attribution": "nested",
        "images": true,
        "queue": {
          "durable": false,
        },
      }
    `);
    await session.prompt("hold");
    const first = await session.steerOrQueue("queued-one");
    const second = await session.deliver("queued-two", { when: "now" });
    expect([first.landed, second.landed]).toMatchInlineSnapshot(`
      [
        "queued",
        "queued",
      ]
    `);
    const kinds = () => session.records().flatMap((record) => record.kind === "request" ? [record.body.kind] : []);
    expect(kinds()).toMatchInlineSnapshot(`
      [
        "prompt",
        "queue",
        "queue",
      ]
    `);
    await session.abort();
    await expect.poll(() => session.records().filter((record) => record.kind === "frame" && record.body.events.some((event) => event.kind === "turn_ended")).length).toBe(3);
    expect(session.records().flatMap((record) => record.kind === "frame" ? record.body.events.filter((event) => event.kind === "text_delta") : [])).toMatchInlineSnapshot(`
      [
        {
          "kind": "text_delta",
          "text": "echo:queued-one",
        },
        {
          "kind": "text_delta",
          "text": "echo:queued-two",
        },
      ]
    `);
  } finally {
    await session.dispose();
  }
});
