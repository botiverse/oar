import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { inspect } from "node:util";
import { afterEach, expect, test, vi } from "vitest";
import { kimiAccountUsage } from "../../packages/oar/src/runtimes/kimi/account-usage.js";
import type { ExecutableRunner } from "../../packages/oar/src/shared/executable/index.js";

const runExecutable = vi.hoisted(() => vi.fn<ExecutableRunner>());
vi.mock("../../packages/oar/src/shared/executable/index.js", () => ({ runExecutable }));
afterEach(() => { vi.unstubAllGlobals(); runExecutable.mockReset(); });

async function readWith(response: () => Promise<Response>) {
  const home = await mkdtemp(join(tmpdir(), "oar-kimi-usage-response-"));
  try {
    await mkdir(join(home, "credentials"));
    await writeFile(join(home, "credentials", "kimi-code.json"), JSON.stringify({ access_token: "synthetic" }));
    runExecutable.mockResolvedValue({ ok: true, stdout: JSON.stringify({ providers: { "managed:kimi-code": { type: "kimi" } } }), stderr: "", exitCode: 0 });
    vi.stubGlobal("fetch", vi.fn(response));
    return await kimiAccountUsage({ kind: "available", via: "executable", command: "kimi", version: "2.4.1" }, { env: {
      KIMI_CODE_HOME: home, KIMI_CODE_BASE_URL: null, KIMI_CODE_OAUTH_HOST: null, KIMI_OAUTH_HOST: null,
    } });
  } finally { await rm(home, { recursive: true, force: true }); }
}

test.each([
  ["<html>synthetic response</html>", "Kimi usage response is not valid JSON"],
  ["null", "Kimi usage response is not an object"],
  ['{"usage":{"used":"broken","limit":"100"}}', "Kimi usage response contains no usable quota windows"],
])("malformed successful quota response rejects (%#)", async (body, reason) => {
  const pending = readWith(async () => new Response(body));
  await expect(pending).rejects.toThrow("Failed to read Kimi account usage");
  await expect(pending).rejects.toHaveProperty("cause.message", reason);
});

test("a failed response-body read rejects without exposing native details", async () => {
  const outcome = await readWith(async () => new Response(new ReadableStream({
    start(controller): void { controller.error(new Error("synthetic-private-response-body")); },
  }))).catch((error: unknown) => error);
  expect(outcome).toMatchObject({ message: "Failed to read Kimi account usage", cause: { message: "Kimi usage response body could not be read" } });
  expect(inspect(outcome)).not.toContain("synthetic-private-response-body");
});
