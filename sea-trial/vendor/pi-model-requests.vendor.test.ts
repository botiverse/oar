import assert from "node:assert/strict";
import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { expect, onTestFinished, test } from "vitest";
import { createPiRuntime } from "../../packages/oar/src/runtimes/pi/index.js";
import { startPiAimock } from "../harness/aimock.js";
import { runTurn } from "./support/asserts.js";

const native = test.skipIf(process.env.OAR_TEST !== "pi-aimock");
const runtime = createPiRuntime({ execution: "in-process" });
const installation = { kind: "available", via: "bundled" } as const;
const formats = [
  ["anthropic-messages", "anthropic.messages"],
  ["openai-completions", "openai.chat"],
  ["openai-responses", "openai.responses"],
];

async function provider(api: string) {
  const fixture = await startPiAimock(mock => { mock.onMessage(/[\s\S]*/u, { content: "fixture answer" }); }, {
    captureRaw: true, provider: { api, apiKey: "synthetic-provider-key-353" },
    settings: { compaction: { enabled: true, reserveTokens: 128, keepRecentTokens: 1 } },
  });
  onTestFinished(async () => { await fixture.stop(); });
  const dir = process.env.OAR_PI_AGENT_DIR;
  assert.ok(dir !== undefined);
  const extensions = join(dir, "extensions");
  await mkdir(extensions);
  await writeFile(join(extensions, "replace.ts"), 'export default pi => pi.on("before_provider_request", event => ({ ...event.payload, temperature: 0.418 }));');
  const cwd = join(dir, "project");
  await mkdir(cwd);
  return { fixture, options: { cwd, model: "aimock/aimock-model", modelRequests: "latest" as const } };
}

native.each(formats)("Pi captures the final %s provider body and leaves compaction out", async (api, format) => {
  const { fixture, options } = await provider(api);
  const session = await runtime.session(installation, options);
  try {
    assert.ok(session.lastModelRequest !== undefined);
    expect(await session.lastModelRequest()).toBeNull();
    for (const prompt of ["first fixture input", "second fixture input", "third fixture input"]) {
      // oxlint-disable-next-line no-await-in-loop -- The second model call includes the first turn.
      expect(await runTurn(session, prompt)).toEqual({ kind: "completed" });
      // oxlint-disable-next-line no-await-in-loop -- Compare the request attributed to this turn.
      const request = await session.lastModelRequest();
      expect(request).toMatchObject({ format, provider: "aimock", model: "aimock-model", body: { temperature: 0.418 } });
      expect(request?.body).toEqual(fixture.raw.at(-1)?.body);
    }
    const before = await session.lastModelRequest();
    const calls = fixture.raw.length;
    const compact = await session.compact?.();
    expect(compact?.kind).toBe("completed");
    expect(fixture.raw.length).toBeGreaterThan(calls);
    expect(await session.lastModelRequest()).toEqual(before);
  } finally {
    const disposed = session.dispose();
    expect(await session.lastModelRequest?.()).toBeNull();
    await disposed;
  }
}, 60_000);

native("Pi resumes with an empty reading and redacts its provider credential", async () => {
  const { options } = await provider("anthropic-messages");
  const first = await runtime.session(installation, options);
  try { expect(await runTurn(first, "original")).toEqual({ kind: "completed" }); } finally { await first.dispose(); }
  const resumed = await runtime.session(installation, { ...options, resume: first.id });
  try {
    expect(await resumed.lastModelRequest?.()).toBeNull();
    expect(await runTurn(resumed, "second synthetic-provider-key-353")).toEqual({ kind: "completed" });
    const request = await resumed.lastModelRequest?.();
    const body = JSON.stringify(request?.body);
    expect(body).toContain("second [redacted]");
    expect(body).not.toContain("synthetic-provider-key-353");
  } finally { await resumed.dispose(); }
});

native("Google's SDK parameters cannot serve as its wire body, and capture stays opt-in", async () => {
  const { options } = await provider("google-generative-ai");
  await expect(runtime.session(installation, options)).rejects.toMatchObject({ name: "UnsupportedOptionError", option: "modelRequests" });
  const session = await runtime.session(installation, { cwd: options.cwd, model: options.model });
  try { expect(session).not.toHaveProperty("lastModelRequest"); } finally { await session.dispose(); }
});
