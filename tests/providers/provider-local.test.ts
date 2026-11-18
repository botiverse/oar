import { mkdtemp, writeFile, readFile, rm } from "node:fs/promises";
import { existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, expect, test } from "vitest";
import { createPiProviderAuth } from "../../packages/oar/src/runtimes/pi/auth.js";

import captureChildProcesses from "../fixtures/child-process-diagnostics.js";

// oxlint-disable-next-line init-declarations -- Installed before each test and restored in afterEach, including failures.
let capture: ReturnType<typeof captureChildProcesses>;
beforeEach(() => { capture = captureChildProcesses("pi-key-command"); });
afterEach(async () => { capture.stop(); await capture.save(); });

async function fixture() {
  const root = await mkdtemp(join(tmpdir(), "oar-local-auth-"));
  const authPath = join(root, "auth.json"), marker = join(root, "command-ran");
  const script = `require('node:fs').writeFileSync(Buffer.from('${Buffer.from(marker).toString("base64")}','base64').toString(),'ran');console.log('fixture-key')`;
  const key = `!"${process.execPath.replaceAll("\\", "/")}" -e "${script}"`;
  const original = JSON.stringify({ anthropic: { type: "oauth", access: "expired-fixture", refresh: "refresh-fixture", expires: 0 }, deepseek: { type: "api_key", key } });
  await writeFile(authPath, original);
  capture.stage("sdk-and-auth-start");
  const auth = await createPiProviderAuth({ authPath, modelsPath: null });
  return { root, authPath, marker, original, auth };
}

// oxlint-disable-next-line max-statements -- Keep the metadata and resolving controls in one fixture with stage markers.
test("metadata listing does not refresh expired OAuth or execute key commands; resolved status does execute the native key command", async () => {
  const scope = await fixture();
  try {
    capture.stage("metadata-read");
    expect(await scope.auth.listProviders({ resolve: false })).toEqual([
      { providerId: "anthropic", configured: true, method: "oauth", subscription: true },
      { providerId: "deepseek", configured: true, method: "api_key", subscription: false },
    ]);
    expect(existsSync(scope.marker)).toBe(false);
    expect(await readFile(scope.authPath, "utf8")).toBe(scope.original);
    capture.stage("key-command-resolution");
    expect(await scope.auth.status("deepseek")).toMatchObject({ configured: true, method: "api_key" });
    capture.stage("key-command-returned");
    expect(existsSync(scope.marker)).toBe(true);
  } finally { await rm(scope.root, { recursive: true, force: true }); }
});
