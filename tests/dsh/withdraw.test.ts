import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterAll, expect, test } from "vitest";
import { dshRuntime, type Session } from "../../packages/oar/src/index.js";
import { conversationOf } from "../../packages/oar/src/observe/conversation.js";
import { fakeAgentBinary } from "../fixtures/process-tree.js";
import { withdraw } from "../fixtures/withdraw.js";

const dir = mkdtempSync(path.join(tmpdir(), "oar-dsh-withdraw-"));
const command = fakeAgentBinary(dir, [path.resolve(import.meta.dirname, "../fixtures/fake-dsh.mjs")]);
const pngPath = path.join(dir, "tiny.png");
const gifPath = path.join(dir, "tiny.gif");
writeFileSync(pngPath, Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=", "base64"));
writeFileSync(gifPath, Buffer.from("R0lGODlhAQABAIAAAAAAAP///yH5BAEAAAAALAAAAAABAAEAAAIBRAA7", "base64"));
afterAll(() => { rmSync(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 300 }); });

async function open(env: Readonly<Record<string, string>> = {}): Promise<Session> {
  return dshRuntime.session({ kind: "available", via: "executable", command, version: "0.2.1-rc.5" }, { cwd: dir, env });
}

// oxlint-disable-next-line max-statements -- Exercise concurrent queue+withdraw across async attachment storage and rejected image admission.
test("withdraw intercepts an async image queue before attachment storage hands it to DSH, while still refusing rejected queues", async () => {
  const session = await open({ FAKE_DSH_MODE: "hold", FAKE_DSH_IMAGES: "1" });
  try {
    const started = await session.prompt("one");
    expect(started.kind).toBe("accepted");
    const withdrawnId = "55555555-5555-4555-8555-555555555555";
    const [queued, taken] = await Promise.all([
      session.queue("withdrawn-image", { inputId: withdrawnId, images: [{ path: pngPath }] }),
      withdraw(session, withdrawnId),
    ]);
    expect([queued.kind, taken]).toEqual(["accepted", "accepted"]);
    const frames = session.records().filter(record => record.kind === "frame" && record.body.type === "session/event");
    expect(frames.some(record => JSON.stringify(record).includes(withdrawnId))).toBe(false);
    expect([...conversationOf(session.records()).inputs.values()].find(item => item.inputId === withdrawnId)?.state).toBe("withdrawn");

    const rejectedId = "66666666-6666-4666-8666-666666666666";
    const [rejectedQueue, rejectedWithdraw] = await Promise.all([
      session.queue("unsupported-gif", { inputId: rejectedId, images: [{ path: gifPath }] }),
      withdraw(session, rejectedId),
    ]);
    expect([rejectedQueue.kind, rejectedWithdraw]).toEqual(["rejected", "not_queued"]);
  } finally {
    await session.dispose();
  }
});
