import { mkdtemp, writeFile, readFile, rm } from "node:fs/promises";
import { existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, test } from "vitest";
import { createPiProviderAuth } from "../../packages/oar/src/runtimes/pi/auth.js";

async function fixture() {
  const root = await mkdtemp(join(tmpdir(), "oar-local-auth-"));
  const authPath = join(root, "auth.json"), marker = join(root, "command-ran");
  const script = `require('node:fs').writeFileSync(Buffer.from('${Buffer.from(marker).toString("base64")}','base64').toString(),'ran');console.log('fixture-key')`;
  const key = `!"${process.execPath.replaceAll("\\", "/")}" -e "${script}"`;
  const original = JSON.stringify({ anthropic: { type: "oauth", access: "expired-fixture", refresh: "refresh-fixture", expires: 0 }, deepseek: { type: "api_key", key } });
  await writeFile(authPath, original);
  const auth = await createPiProviderAuth({ authPath, modelsPath: null });
  return { root, authPath, marker, original, auth };
}

test("metadata listing does not refresh expired OAuth or execute key commands; resolved status does execute the native key command", async () => {
  const scope = await fixture();
  try {
    expect(await scope.auth.listProviders({ resolve: false })).toEqual([
      { providerId: "anthropic", configured: true, method: "oauth", subscription: true },
      { providerId: "deepseek", configured: true, method: "api_key", subscription: false },
    ]);
    expect(existsSync(scope.marker)).toBe(false);
    expect(await readFile(scope.authPath, "utf8")).toBe(scope.original);
    expect(await scope.auth.status("deepseek")).toMatchObject({ configured: true, method: "api_key" });
    expect(existsSync(scope.marker)).toBe(true);
  } finally { await rm(scope.root, { recursive: true, force: true }); }
});
