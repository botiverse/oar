import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { expect, test } from "vitest";
import { awaitTurnEnd, defaultRuntimes } from "../../packages/oar/src/index.js";
import { asRecord } from "../../packages/oar/src/shared/json.js";
import { startClaudeAimock, startCodexAimock, startPiAimock, type AimockEnv } from "../harness/aimock.js";
import { startAntigravityAimock, startGrokAimock, startKimiAimock, startOpencodeAimock } from "../harness/aimock-acp.js";

// Grok drops images smaller than 8×8. Use a 32×32 PNG across providers.
const PNG = "iVBORw0KGgoAAAANSUhEUgAAACAAAAAgCAIAAAD8GO2jAAAAKElEQVR4nO3NsQ0AAAzCMP5/un0CNkuZ41wybXsHAAAAAAAAAAAAxR4yw/wuPL6QkAAAAABJRU5ErkJggg==";
const answer = { content: "image received" };
const recipes: Readonly<Record<string, { readonly model?: string; readonly start: () => Promise<AimockEnv> }>> = {
  claude: { model: "haiku", start: async () => startClaudeAimock(undefined, { captureRaw: true }) },
  codex: { model: "gpt-5.1", start: async () => startCodexAimock(undefined, { captureRaw: true }) },
  pi: { model: "aimock/aimock-model", start: async () => startPiAimock(undefined, { captureRaw: true, imageInput: true }) },
  grok: { start: async () => startGrokAimock((mock) => { mock.onMessage(/[\s\S]*/u, answer); }) },
  kimi: { start: async () => {
    const env = await startKimiAimock((mock) => { mock.onMessage(/[\s\S]*/u, answer); });
    return { ...env, env: { ...env.env, KIMI_MODEL_CAPABILITIES: "image_in" } };
  } },
  opencode: { start: async () => startOpencodeAimock((mock) => { mock.onMessage(/[\s\S]*/u, answer); }) },
  antigravity: { start: async () => startAntigravityAimock((mock) => { mock.onMessage(/[\s\S]*/u, answer); }) },
};

/** The provider content array with our image, excluding other system/context messages. */
function imageContent(value: unknown): readonly unknown[] | undefined {
  if (Array.isArray(value)) {
    const parts: readonly unknown[] = value;
    if (parts.some((item) => {
      const part = asRecord(item);
      return part !== null && (part.type === "image" || part.type === "image_url" || part.type === "input_image" || part.inlineData !== undefined)
        && JSON.stringify(part).includes(PNG);
    })) { return parts; }
  }
  if (value !== null && typeof value === "object") {
    for (const child of Object.values(value)) {
      const found = imageContent(child);
      if (found !== undefined) { return found; }
    }
  }
  return undefined;
}

for (const [id, recipe] of Object.entries(recipes)) {
  test.skipIf(process.env.OAR_TEST !== `${id}-aimock`)(`${id}: image-only input reaches the scripted provider without an empty text block`, async () => {
    const dir = await mkdtemp(path.join(tmpdir(), "oar-image-only-"));
    const env = await recipe.start();
    try {
      const image = path.join(dir, "dot.png");
      await writeFile(image, Buffer.from(PNG, "base64"));
      const runtime = defaultRuntimes.require(id);
      const installation = await runtime.installation?.();
      assert.ok(installation?.kind === "available");
      const session = await runtime.session(installation, {
        cwd: dir,
        ...(recipe.model === undefined ? {} : { model: recipe.model }),
        env: { ...env.env, ...(id === "claude" ? { CLAUDE_CONFIG_DIR: dir, CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC: "1" } : {}) },
      });
      try {
        const result = await session.prompt("", { images: [{ path: image }] });
        expect(result.response.body.kind).toBe("accepted");
        expect(result.request.body).toMatchObject({ kind: "prompt", input: "", images: [{ path: image }] });
        expect(await awaitTurnEnd(session, result.request.seq)).toEqual({ kind: "completed" });
        const content = env.raw.map((request) => imageContent(request.body)).findLast((parts) => parts !== undefined);
        expect(content, "the image bytes reached the model provider").toBeDefined();
        // Native harnesses add source labels, delimiters or metadata; OAR
        // must not send an empty user-text block alongside the image.
        expect(content?.filter((part) => asRecord(part)?.text === "")).toEqual([]);
      } finally {
        await session.dispose();
      }
    } finally {
      await env.stop();
      await rm(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
    }
  }, 90_000);
}
