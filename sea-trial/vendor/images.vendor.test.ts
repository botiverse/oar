import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { expect, test } from "vitest";
import { awaitTurnEnd, defineRuntime, piInstallation, piSession, defaultRuntimes, type Session } from "../../packages/oar/src/index.js";
import { startClaudeAimock, startCodexAimock, startPiAimock, type AimockEnv } from "../harness/aimock.js";
import { runtimeUnderTest } from "../harness/subject.js";

/** A 1×1 PNG. */
const PNG = "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==";

/** The part of a provider request that carries the image bytes, with the bytes cut out: what the runtime made of `InputOptions.images`. */
function imagePart(value: unknown): unknown {
  if (typeof value !== "object" || value === null) {
    return undefined;
  }
  const entries = Object.entries(value);
  if (entries.some(([, field]) => typeof field === "string" && field.includes(PNG))) {
    return Object.fromEntries(entries.map(([key, field]) => [key, typeof field === "string" && field.includes(PNG) ? field.replace(PNG, "<png>") : field]));
  }
  for (const [, field] of entries) {
    const found = imagePart(field);
    if (found !== undefined) {
      return found;
    }
  }
  return undefined;
}

async function sendImage(open: (cwd: string) => Promise<Session>, env: AimockEnv): Promise<unknown> {
  const cwd = await mkdtemp(path.join(tmpdir(), "oar-images-vendor-"));
  const image = path.join(cwd, "dot.png");
  await writeFile(image, Buffer.from(PNG, "base64"));
  try {
    const session = await open(cwd);
    try {
      const started = await session.prompt("what color is this?", { images: [{ path: image }] });
      assert.equal(started.response.body.kind, "accepted", JSON.stringify(started.response.body));
      assert.deepEqual(await awaitTurnEnd(session, started.request.seq), { kind: "completed" });
    } finally {
      await session.dispose();
    }
    const part = env.raw.map((request) => imagePart(request.body)).find((found) => found !== undefined);
    assert.ok(part !== undefined, "the image bytes reached the provider");
    return part;
  } finally {
    await rm(cwd, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
  }
}

test.skipIf(process.env.OAR_TEST !== "claude-aimock")("claude sends an input image as an image block", async () => {
  const env = await startClaudeAimock(undefined, { captureRaw: true });
  try {
    const runtime = defaultRuntimes.require("claude");
    const installation = await runtime.installation?.();
    assert.ok(installation?.kind === "available");
    const part = await sendImage(async (cwd) => {
      const session = await runtime.session(installation, {
        cwd,
        model: "haiku",
        env: { ...env.env, CLAUDE_CONFIG_DIR: cwd, CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC: "1" },
      });
      return session;
    }, env);
    expect(part).toMatchInlineSnapshot(`
      {
        "data": "<png>",
        "media_type": "image/png",
        "type": "base64",
      }
    `);
  } finally {
    await env.stop();
  }
}, 60_000);

test.skipIf(process.env.OAR_TEST !== "codex-aimock")("codex sends an input image as a localImage it reads itself", async () => {
  const env = await startCodexAimock(undefined, { captureRaw: true });
  try {
    const runtime = defaultRuntimes.require("codex");
    const installation = await runtime.installation?.();
    assert.ok(installation?.kind === "available");
    const part = await sendImage(async (cwd) => {
      const session = await runtime.session(installation, { cwd, model: "gpt-5.1", env: { ...env.env } });
      return session;
    }, env);
    expect(part).toMatchInlineSnapshot(`
      {
        "detail": "high",
        "image_url": "data:image/png;base64,<png>",
        "type": "input_image",
      }
    `);
  } finally {
    await env.stop();
  }
}, 60_000);

test.skipIf(process.env.OAR_TEST !== "pi-aimock")("pi sends an input image as ImageContent", async () => {
  const env = await startPiAimock(undefined, { captureRaw: true, imageInput: true });
  try {
    const runtime = defineRuntime({ id: "pi-aimock", session: piSession, installation: piInstallation });
    const part = await sendImage(async () => {
      const session = await runtimeUnderTest(runtime).startSession();
      return session;
    }, env);
    expect(part).toMatchInlineSnapshot(`
      {
        "data": "<png>",
        "media_type": "image/png",
        "type": "base64",
      }
    `);
  } finally {
    await env.stop();
  }
}, 60_000);
