import assert from "node:assert/strict";
import { writeFile } from "node:fs/promises";
import path from "node:path";
import { expect, test } from "vitest";
import { awaitTurnEnd, promptAndWait, type Session } from "../../packages/oar/src/index.js";
import { dshEnabled, eventsOf, say, withDshFixture } from "./support/dsh-fixture.js";

const png = "iVBORw0KGgoAAAANSUhEUgAAACAAAAAgCAIAAAD8GO2jAAAAKElEQVR4nO3NsQ0AAAzCMP5/un0CNkuZ41wybXsHAAAAAAAAAAAAxR4yw/wuPL6QkAAAAABJRU5ErkJggg==";
async function prompt(session: Session, text: string): Promise<void> {
  const reply = await session.prompt(text);
  expect(reply.kind).toBe("accepted");
  expect(await awaitTurnEnd(session, reply.seq)).toEqual({ kind: "completed" });
}

const vision = { models: [
  { id: "aimock-model", input: ["text", "image"], contextWindow: 32_768, maxTokens: 2048 },
  { id: "text-model", input: ["text"], contextWindow: 32_768, maxTokens: 2048 },
] };

test.skipIf(!dshEnabled)("DSH sends the original PNG to the selected vision route, including image-only input", async () => {
  await withDshFixture(() => say("ok"), async ({ open, aimock, provider }) => {
    const file = path.join(aimock.cwd, "test.png");
    await writeFile(file, Buffer.from(png, "base64"));
    const session = await open({ model: "aimock/aimock-model" });
    expect(session.capabilities.images).toBe(true);
    for (const text of ["image and text", ""]) {
      // oxlint-disable-next-line no-await-in-loop -- Check two independent image admissions on this session.
      const result = await session.prompt(text, { images: [{ path: file }] });
      expect(result.kind).toBe("accepted");
      // oxlint-disable-next-line no-await-in-loop -- Check the provider before the next input.
      expect(await awaitTurnEnd(session, result.seq)).toEqual({ kind: "completed" });
      expect(JSON.stringify(provider.requests.at(-1)?.messages)).toContain(png);
    }
  }, vision);
}, 60_000);

test.skipIf(!dshEnabled)("DSH restores the saved image route on resume and refuses image input on a text-only route", async () => {
  await withDshFixture(() => say("ok"), async ({ open, aimock, provider }) => {
    const file = path.join(aimock.cwd, "test.png");
    await writeFile(file, Buffer.from(png, "base64"));
    const first = await open({ model: "aimock/aimock-model" });
    await prompt(first, "save this route");
    await first.dispose();
    const resumed = await open({ resume: first.id });
    expect(resumed.capabilities.images).toBe(true);
    const reply = await resumed.queue("", { images: [{ path: file }] });
    expect(reply.kind).toBe("accepted");
    expect(await awaitTurnEnd(resumed, reply.seq)).toEqual({ kind: "completed" });
    expect(JSON.stringify(provider.requests.at(-1)?.messages)).toContain(png);
    const textOnly = await open({ model: "aimock/text-model" });
    expect(textOnly.capabilities.images).toBe(false);
    const before = provider.requests.length;
    expect(await textOnly.prompt("with image", { images: [{ path: file }] })).toMatchObject({ kind: "rejected", code: "unsupported" });
    expect(provider.requests).toHaveLength(before);
  }, vision);
}, 60_000);

test.skipIf(!dshEnabled)("DSH manual compaction uses the native result and matching start/end, and leaves the session usable", async () => {
  await withDshFixture(() => say("Two source facts remain."), async ({ open }) => {
    const session = await open({ model: "aimock/aimock-model" });
    assert.ok(session.compact !== undefined);
    expect(await session.compact()).toMatchObject({ kind: "failed", code: "not_compacted" });
    await prompt(session, `alpha${" source".repeat(1600)}`);
    await prompt(session, `bravo${" source".repeat(1600)}`);
    const result = await session.compact({ timeoutMs: 30_000 });
    expect(result.kind).toBe("completed");
    const events = eventsOf(session.records(), session.id);
    expect(events.some(event => event.kind === "compaction_started")).toBe(true);
    expect(events.some(event => event.kind === "compaction_ended" && event.outcome === "completed")).toBe(true);
    expect(session.status().value.kind).toBe("idle");
    await prompt(session, "continue");
  }, { ...vision, homePatch: [{ id: "compaction-basic", config: { auto: false, retainTokens: 200, headroomTokens: 128, maxTokens: 1024 } }] });
}, 90_000);

test.skipIf(!dshEnabled).each([true, false])("DSH abort reaches the active compaction and gates competing input (caller timed out: %s)", async (timeout) => {
  let hold = false;
  await withDshFixture(() => hold ? { kind: "hold", text: "Short summary." } : say("ack"), async ({ open, provider }) => {
    const session = await open({ model: "aimock/aimock-model" });
    assert.ok(session.compact !== undefined);
    await prompt(session, `two${" facts".repeat(2200)}`);
    await prompt(session, `more${" facts".repeat(2200)}`);
    hold = true;
    const wait = session.compact({ timeoutMs: timeout ? 0 : 30_000 });
    try {
      await provider.held();
      if (timeout) { expect(await wait).toMatchObject({ kind: "unconfirmed", code: "timeout" }); }
      expect(await session.prompt("competing")).toMatchObject({ kind: "rejected", code: "busy" });
      expect(await session.queue("competing")).toMatchObject({ kind: "rejected", code: "busy" });
      expect(await session.compact()).toMatchObject({ kind: "rejected", code: "busy" });
      expect(await session.abort()).toMatchObject({ kind: "accepted" });
    } finally { hold = false; provider.release(); }
    const outcome = await wait;
    if (!timeout) { expect(outcome.kind).toBe("aborted"); }
    // The caller can stop waiting before DSH delivers the terminal reply for this compact request.
    const terminalReply = () => session.records().find(record =>
      record.kind === "frame" && record.body.responseTo === outcome.request.id);
    await expect.poll(terminalReply, { timeout: 30_000 }).toMatchObject({
      body: { type: "dsh/compact/error", native: { name: "AbortError" } },
    });
    expect(session.status().value.kind).toBe("idle");
    await prompt(session, "after cancellation");
  }, { ...vision, homePatch: [{ id: "compaction-basic", config: { auto: false, retainTokens: 200, headroomTokens: 128, maxTokens: 1024 } }] });
}, 90_000);

test.skipIf(!dshEnabled)("DSH accepts another input after its compaction provider fails", async () => {
  let failing = false;
  await withDshFixture(() => failing
    ? { kind: "error", status: 400, body: { message: "Controlled compaction failure", type: "invalid_request_error" } }
    : say("ok"), async ({ open }) => {
    const session = await open({ model: "aimock/aimock-model" });
    assert.ok(session.compact !== undefined);
    await prompt(session, `alpha${" source".repeat(1600)}`);
    await prompt(session, `bravo${" source".repeat(1600)}`);
    failing = true;
    expect(await session.compact({ timeoutMs: 30_000 })).toMatchObject({ kind: "failed", code: "native_failed" });
    expect(session.status().value.kind).toBe("idle");
    failing = false;
    await prompt(session, "continue after failure");
  }, { ...vision, homePatch: [{ id: "compaction-basic", config: { auto: false, retainTokens: 200, headroomTokens: 128, maxTokens: 1024 } }] });
}, 90_000);

test.skipIf(!dshEnabled)("DSH preserves the active turn's overflow failure when automatic compaction fails", async () => {
  let failing = false;
  let faultCalls = 0;
  await withDshFixture(() => {
    if (!failing) { return say("Source information. ".repeat(90)); }
    faultCalls += 1;
    const first = faultCalls === 1;
    return { kind: "error", status: 400, body: { type: "invalid_request_error", code: first ? "context_length_exceeded" : "invalid_request_error",
      message: first ? "This model's maximum context length is 10000 tokens. However, your messages resulted in 18000 tokens." : "Controlled summary failure" } };
  }, async ({ open }) => {
    const session = await open({ model: "aimock/aimock-model" });
    await prompt(session, "alpha source ".repeat(300));
    await prompt(session, "beta source ".repeat(300));
    const before = session.records().length;
    failing = true;
    expect(await promptAndWait(session, "overflow")).toMatchObject({ kind: "ended", outcome: { kind: "failed", failure: "input_too_large" } });
    const events = eventsOf(session.records().slice(before), session.id);
    const ended = events.find(event => event.kind === "compaction_ended");
    expect(ended?.outcome).toBe("failed");
    expect(ended?.reason).toContain("Controlled summary failure");
    expect(session.status().value.kind).toBe("idle");
    failing = false;
    await prompt(session, "after recovery");
  }, { homePatch: [{ id: "compaction-basic", config: { auto: true, retainTokens: 200, headroomTokens: 128, maxTokens: 1024 } }] });
}, 90_000);
