/** pnpm tsx experiments/orientation/cursor-status.ts; synthetic stores, no login or model request. */
import assert from "node:assert/strict";
import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { Socket } from "node:net";
import { tmpdir } from "node:os";
import path from "node:path";
import { createCursorRuntime, orient, RuntimeRegistry } from "../../packages/oar/src/index.js";
import { runExecutable } from "../../packages/oar/src/shared/executable/index.js";

async function isolated(): Promise<void> {
  let networkAttempts = 0;
  const blockNetwork = (): never => { networkAttempts += 1; throw new Error("probe blocked network access"); };
  const originalConnect = Object.getOwnPropertyDescriptor(Socket.prototype, "connect"), originalFetch = globalThis.fetch;
  assert.ok(originalConnect !== undefined);
  Socket.prototype.connect = blockNetwork;
  globalThis.fetch = blockNetwork;
  try {
    const sdk = await import("@cursor/sdk");
    const registry = new RuntimeRegistry([createCursorRuntime({ sdk: async () => { const loaded = await import("@cursor/sdk"); return loaded; } })]);
    const authFile = sdk.getDefaultSdkAuthPath();
    assert.ok(authFile.startsWith(process.env.HOME ?? "missing isolated HOME"));
    await mkdir(path.dirname(authFile), { recursive: true });
    const stored = { version: 1, backendUrl: "https://stored.invalid", apiKey: "synthetic-stored-key", createdAtMs: Date.now(), email: "fixture@example.invalid", apiKeyExpiresAtMs: Date.now() + 3_600_000 };

    const check = async (label: string, contents: string | undefined, expected: "logged_in" | "logged_out"): Promise<void> => {
      await rm(authFile, { force: true });
      if (contents !== undefined) { await writeFile(authFile, contents); }
      const native = await sdk.Cursor.auth.status();
      assert.equal(native.status, expected === "logged_in" ? "logged-in" : "logged-out");
      const snapshot = await orient(registry);
      const auth = snapshot.runtimes[0]?.auth;
      assert.ok(auth?.kind === "ok");
      assert.equal(auth.value.kind, process.env.CURSOR_API_KEY === undefined ? expected : "unknown");
      if (process.env.CURSOR_API_KEY !== undefined) { assert.equal("account" in auth.value, false, "the stored identity is not the session's environment key"); }
      assert.equal(networkAttempts, 0, "SDK load and status must not attempt any socket connection or fetch");
      assert.ok(!JSON.stringify(snapshot).includes("synthetic-"), "no credential is projected");
      assert.equal(await readFile(authFile, "utf8").catch(() => null), contents ?? null, "status does not rewrite the store");
      console.log(JSON.stringify({ label, native: native.status, auth: auth.value, networkAttempts }));
    };

    await check("missing store", undefined, "logged_out");
    await check("malformed JSON", "{", "logged_out");
    await check("foreign credential shape", JSON.stringify({ accessToken: "synthetic-access", refreshToken: "synthetic-refresh" }), "logged_out");
    await check("stored unexpired key", JSON.stringify(stored), "logged_in");
    await check("stored key without expiry", JSON.stringify({ ...stored, apiKeyExpiresAtMs: undefined }), "logged_in");
    await check("stored expired key", JSON.stringify({ ...stored, apiKeyExpiresAtMs: 1 }), "logged_out");
    process.env.CURSOR_API_KEY = "synthetic-env-key";
    await check("environment key without a stored login", undefined, "logged_out");
    await check("environment key alongside a stored login", JSON.stringify(stored), "logged_in");
    await check("environment key does not revive an expired login", JSON.stringify({ ...stored, apiKeyExpiresAtMs: 1 }), "logged_out");
    process.env.CURSOR_API_KEY = "";
    await check("empty environment key still overrides the stored login", JSON.stringify(stored), "logged_in");
    delete process.env.CURSOR_API_KEY;
    process.env.CURSOR_BACKEND_URL = "https://different.invalid";
    await check("backend override does not resolve or validate the stored key", JSON.stringify(stored), "logged_in");

    // Native callers can supply an arbitrary store; OAR passes no status options.
    const memory = new sdk.InMemoryCredentialStore();
    await memory.save({ ...stored, version: 1 });
    const unexpired = await sdk.Cursor.auth.status({ store: memory });
    assert.equal(unexpired.status, "logged-in");
    await memory.save({ ...stored, version: 1, apiKeyExpiresAtMs: 1 });
    const expired = await sdk.Cursor.auth.status({ store: memory });
    assert.equal(expired.status, "logged-out");
    assert.equal(networkAttempts, 0);
    await assert.rejects(sdk.Cursor.auth.status({ store: {
      load: async (): Promise<undefined> => { await fetch("https://store.invalid"); },
      save: async () => {}, clear: async () => {},
    } }));
    assert.equal(networkAttempts, 1, "the guard catches a network-enabled custom store; it is outside OAR's call shape");
    console.log(JSON.stringify({ label: "native custom-store controls", memoryStatuses: ["logged-in", "logged-out"], networkStoreBlocked: true }));
  } finally {
    Object.defineProperty(Socket.prototype, "connect", originalConnect);
    globalThis.fetch = originalFetch;
  }
}

if (process.argv.includes("--isolated")) {
  await isolated();
} else {
  const home = await mkdtemp(path.join(tmpdir(), "oar-cursor-status-"));
  const env: NodeJS.ProcessEnv = { HOME: home, USERPROFILE: home };
  for (const key of ["PATH", "SystemRoot", "WINDIR", "ComSpec", "PATHEXT", "TMP", "TEMP", "TMPDIR"]) {
    if (process.env[key] !== undefined) { env[key] = process.env[key]; }
  }
  try {
    const result = await runExecutable(process.execPath, ["--import", "tsx", import.meta.filename, "--isolated"], { env, timeoutMs: 30_000 });
    process.stdout.write(result.stdout);
    assert.ok(result.ok, result.stderr);
  } finally {
    await rm(home, { recursive: true, force: true });
  }
}
