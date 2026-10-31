import { fileURLToPath } from "node:url";
import { expect, test } from "vitest";
import { acpSession } from "../../packages/oar/src/shared/acp/session.js";
import { asRecord } from "../../packages/oar/src/shared/json.js";
import { gone } from "../fixtures/process-tree.js";

// Windows needs capture before protocol cancellation; POSIX disposal uses its own process groups.
// oxlint-disable-next-line eslint/max-statements -- Drive the public isolated session through a cancel that orphans a real tool.
test.skipIf(process.platform !== "win32")("ACP disposal captures tools before native cancellation severs their parent chain", async () => {
  const session = await acpSession({ args: [fileURLToPath(new URL("../fixtures/shutdown-orphan-tree.mjs", import.meta.url)), "acp"], capabilities: { queue: { durable: false }, attribution: "opaque" } })(
    { kind: "available", via: "executable", command: process.execPath }, { cwd: process.cwd() },
  );
  let owned: { middle: number; tool: number } | undefined = undefined;
  try {
    await session.prompt("start");
    await expect.poll(() => session.records().flatMap(r => r.kind === "frame" ? r.body.events.filter(e => e.kind === "text_delta").map(e => e.text) : []).join(""), { timeout: 10_000 }).not.toBe("");
    const text = session.records().flatMap(r => r.kind === "frame" ? r.body.events.filter(e => e.kind === "text_delta").map(e => e.text) : []).join("");
    const value = asRecord(JSON.parse(text));
    expect(typeof value?.middle).toBe("number"); expect(typeof value?.tool).toBe("number");
    owned = { middle: Number(value?.middle), tool: Number(value?.tool) };
    expect(await gone(owned.middle, 50)).toBe(false); expect(await gone(owned.tool, 50)).toBe(false);
    await session.dispose();
    expect(await gone(owned.middle)).toBe(true); expect(await gone(owned.tool)).toBe(true);
    const exits = session.records().filter(r => r.kind === "response" && r.body.kind === "exited");
    expect(exits).toHaveLength(1); expect(exits[0]?.body).not.toHaveProperty("reason");
  } finally {
    await session.dispose();
    for (const pid of owned === undefined ? [] : [owned.middle, owned.tool]) { try { process.kill(pid, "SIGKILL"); } catch { /* Already reclaimed. */ } }
  }
});
