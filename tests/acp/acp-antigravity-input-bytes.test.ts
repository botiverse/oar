/* oxlint-disable eslint/max-statements -- Each test follows one input from refusal to the next delivery on the same session. */
// Contributed by Otter in the #755 review: boundary checks for the Antigravity input byte bound.
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { expect, test } from "vitest";
import { antigravityAcpProfile } from "../../packages/oar/src/runtimes/antigravity/session.js";
import { acpSession } from "../../packages/oar/src/shared/acp/session.js";
import { conversationOf } from "../../packages/oar/src/observe/conversation.js";
import { awaitTurnEnd, promptAndWait } from "../../packages/oar/src/observe/turns.js";
import type { Session } from "../../packages/oar/src/contracts/session.js";
import { fixture, start } from "../fixtures/acp-session-support.js";

const limit = 185_000;
const fits = "😀".repeat(limit / 4);
const over = `${fits}x`;
const refusedId = "75500000-0000-4000-8000-000000000001";
const keptId = "75500000-0000-4000-8000-000000000002";

async function open(gate?: string) {
  return acpSession({ ...antigravityAcpProfile, args: [fixture, "antigravity"] })(
    { kind: "available", via: "executable", command: process.execPath },
    { cwd: process.cwd(), ...(gate === undefined ? {} : { env: { FAKE_ACP_STEER_FINISH: gate } }) },
  );
}
function texts(session: Session) {
  return session.records().flatMap(record => record.kind === "frame"
    ? record.body.events.flatMap(event => event.kind === "text_delta" ? [event.text] : []) : []);
}
function refusedInput(session: Session) {
  return [...conversationOf(session.records()).inputs.values()].find(input => input.inputId === refusedId);
}

test("UTF-8 boundary refusal leaves caller input intact and reads no attached image", async () => {
  const session = await open();
  try {
    expect(Buffer.byteLength(fits, "utf8")).toBe(limit);
    const answer = await session.prompt(over, { inputId: refusedId, images: [{ path: "/missing-review755-image.png" }] });
    expect(answer.response.body).toMatchObject({ kind: "rejected", code: "unsupported", failure: "input_too_large" });
    expect(refusedInput(session)).toMatchObject({ input: over, state: "rejected", observations: [] });
    expect(session.status().value.kind).toBe("idle");
    expect(texts(session)).toEqual([]);
    expect(await promptAndWait(session, fits)).toMatchObject({ kind: "ended" });
    expect(texts(session)).toEqual([`echo:${fits}`]);
  } finally { await session.dispose(); }
});

test.each(["steer", "queue"] as const)("oversize %s does not end or poison the active turn and never drains", async kind => {
  const dir = mkdtempSync(path.join(tmpdir(), "review755-held-"));
  const gate = path.join(dir, "finish");
  const session = await open(gate);
  try {
    const original = await session.prompt("agy-original-held");
    expect(original.response.body.kind).toBe("accepted");
    const answer = kind === "steer"
      ? await session.steer?.(over, { inputId: refusedId })
      : await session.queue(over, { inputId: refusedId });
    expect(answer?.response.body).toMatchObject({ kind: "rejected", code: "unsupported", failure: "input_too_large" });
    expect(refusedInput(session)).toMatchObject({ input: over, state: "rejected", observations: [] });
    expect(session.status().value.kind).toBe("running");
    const withdrawn = await session.withdraw?.(refusedId);
    expect(withdrawn?.response.body).toMatchObject({ kind: "rejected", code: "not_queued" });
    const queued = await session.queue(fits, { inputId: keptId });
    expect(queued.response.body).toEqual({ kind: "accepted", queued: "adapter" });
    writeFileSync(gate, "ok");
    expect(await awaitTurnEnd(session, original.request.seq)).toEqual({ kind: "completed" });
    await expect.poll(() => texts(session).length).toBe(1);
    await expect.poll(() => session.status().value.kind).toBe("idle");
    expect(texts(session)).toEqual([`echo:${fits}`]);
    expect(refusedInput(session)).toMatchObject({ input: over, state: "rejected", observations: [] });
    expect(session.records().flatMap(record => record.kind === "frame" ? record.body.events : [])
      .filter(event => event.kind === "input_dropped")).toEqual([]);
    expect(await promptAndWait(session, "later work")).toMatchObject({ kind: "ended" });
  } finally { await session.dispose(); rmSync(dir, { recursive: true, force: true }); }
});

test("an ACP profile without a byte policy still delivers the same larger input", async () => {
  const session = await start();
  try {
    expect(await promptAndWait(session, over)).toMatchObject({ kind: "ended" });
    expect(texts(session)).toEqual([`echo:${over}`]);
  } finally { await session.dispose(); }
});
