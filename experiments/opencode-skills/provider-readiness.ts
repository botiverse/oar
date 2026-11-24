/* oxlint-disable import/max-dependencies, no-await-in-loop -- This native probe drives an HTTP registry, sequential catalog reads and one ordered event stream. */
// Run from the checkout with node --import tsx and a 2.4.0 or 2.4.1 executable on Linux.
// The loopback package registers a synthetic login method. No account operations are submitted.
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { once } from "node:events";
import { createHash } from "node:crypto";
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { asRecord, asRecordList } from "../../packages/oar/src/shared/json.js";
import { OpencodeProviderAuthFacade } from "../../packages/oar/src/runtimes/opencode/provider-auth-facade.js";

const [binary] = process.argv.slice(2);
assert.ok(binary !== undefined && binary.length > 0);
const command = resolve(binary);
const root = await mkdtemp(join(tmpdir(), "oar-auth-readiness-"));
const project = join(root, "project");
const pkg = "oar-activation-fixture";
const provider = "oar-fixture-login";
const release = Promise.withResolvers<void>();
const requested = Promise.withResolvers<void>();
const registry = createServer();
const realFetch = globalThis.fetch;
let facade: OpencodeProviderAuthFacade | null = null;
const events: Record<"pending" | "released", Record<string, number>> = { pending: {}, released: {} };
let phase: keyof typeof events = "pending";
const stopEvents = new AbortController();
const streamState: { subscribed: boolean; done: Promise<void>; error?: unknown } = { subscribed: false, done: Promise.resolve() };
async function missingRequest(): Promise<never> {
  await delay(10_000, undefined, { ref: false });
  throw new Error("package request never arrived");
}

async function readEvents(response: Response): Promise<void> {
  assert.ok(response.body !== null);
  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let buffer = "";
  for (;;) {
    const next = await reader.read();
    if (next.done) { break; }
    assert.ok(next.value instanceof Uint8Array);
    buffer += decoder.decode(next.value, { stream: true });
    let end = 0;
    while ((end = buffer.indexOf("\n\n")) >= 0) {
      const frame = buffer.slice(0, end);
      buffer = buffer.slice(end + 2);
      if (frame.startsWith("data:")) {
        const type = asRecord(JSON.parse(frame.slice(5)))?.type;
        assert.ok(typeof type === "string");
        events[phase][type] = (events[phase][type] ?? 0) + 1;
      }
    }
  }
}
try {
  await mkdir(join(project, ".git"), { recursive: true });
  await mkdir(join(root, "package"));
  await writeFile(join(project, "opencode.json"), JSON.stringify({ plugins: [`${pkg}@1.0.0`] }));
  const manifest = { name: pkg, version: "1.0.0", type: "module", exports: { "./server": "./index.js" } };
  await writeFile(join(root, "package/package.json"), JSON.stringify(manifest));
  await writeFile(join(root, "package/index.js"), `
    export default { id: "oar-fixture-plugin", async setup(ctx) {
      await ctx.integration.transform(editor => {
        editor.update("oar-fixture-login", integration => { integration.name = "Fixture login"; });
        editor.method.update({ integrationID: "oar-fixture-login", method: { type: "key" } });
      });
    } };
  `);
  const tarball = execFileSync("tar", ["-czf", "-", "package"], { cwd: root });
  registry.listen(0, "127.0.0.1");
  await once(registry, "listening");
  const bound = registry.address();
  assert.ok(bound !== null && typeof bound === "object");
  const registryUrl = `http://127.0.0.1:${String(bound.port)}`;
  const dist = { tarball: `${registryUrl}/package.tgz`, integrity: `sha512-${createHash("sha512").update(tarball).digest("base64")}` };
  registry.on("request", (request, response) => {
    if (request.url === `/${pkg}`) {
      requested.resolve();
      void (async (): Promise<void> => {
        await release.promise;
        response.writeHead(200, { "content-type": "application/json" });
        response.end(JSON.stringify({ name: pkg, "dist-tags": { latest: "1.0.0" }, versions: { "1.0.0": { ...manifest, dist } } }));
      })();
    } else if (request.url === "/package.tgz") {
      response.end(tarball);
    } else {
      response.writeHead(404).end();
    }
  });

  // Observe only counts and the fixture ID from the real reads the facade makes.
  const observed = { "/api/plugin": { count: 0, hasFixture: false }, "/api/integration": { count: 0, hasFixture: false } };
  globalThis.fetch = async (url, options): Promise<Response> => {
    const address = url instanceof Request ? url.url : url;
    if (!streamState.subscribed) {
      streamState.subscribed = true;
      const stream = await realFetch(new URL("/api/event", address), {
        headers: new Headers(options?.headers), signal: stopEvents.signal,
      });
      assert.equal(stream.status, 200);
      streamState.done = (async (): Promise<void> => {
        try { await readEvents(stream); }
        catch (error) { if (!stopEvents.signal.aborted) { streamState.error = error; } }
      })();
    }
    const response = await realFetch(url, options);
    const path = new URL(address).pathname;
    if (path === "/api/plugin" || path === "/api/integration") {
      const data = asRecordList(asRecord(await response.clone().json())?.data);
      observed[path] = { count: data.length, hasFixture: data.some(row => row.id === provider) };
    }
    return response;
  };
  const env = {
    PATH: process.env.PATH, HOME: root, USERPROFILE: root, XDG_CONFIG_HOME: join(root, "config"),
    XDG_CACHE_HOME: join(root, "cache"), XDG_DATA_HOME: join(root, "data"), XDG_STATE_HOME: join(root, "state"),
    npm_config_registry: registryUrl, npm_config_fetch_retries: "0", HTTP_PROXY: "http://127.0.0.1:9",
    HTTPS_PROXY: "http://127.0.0.1:9", NO_PROXY: "localhost,127.0.0.1",
  };
  const version = execFileSync(command, ["--version"], { env, encoding: "utf8" }).trim();
  const options = { command, env, cwd: project, pollMs: 25, timeoutMs: 10_000, idleMs: 30_000,
    loginTimeoutMs: 10_000, statusPollMs: 25, loopback: "refuse" as const };
  facade = await OpencodeProviderAuthFacade.create(options);
  const hasLogin = (current: OpencodeProviderAuthFacade): boolean => current.loginProviders().some(row => row.providerId === provider);
  const before = { plugins: observed["/api/plugin"].count, integrations: observed["/api/integration"].count,
    nativeHasFixture: observed["/api/integration"].hasFixture, loginProvidersHasFixture: hasLogin(facade) };
  const deadline = Date.now() + 15_000;
  await Promise.race([requested.promise, missingRequest()]);
  assert.ok(before.plugins > 0 && before.integrations > 0 && !before.nativeHasFixture && !before.loginProvidersHasFixture);
  phase = "released";
  release.resolve();
  while (!observed["/api/integration"].hasFixture && Date.now() < deadline) {
    await facade.listProviders();
    await delay(25);
  }
  assert.ok(observed["/api/integration"].hasFixture, "native server did not register the package integration");
  const after = { integrations: observed["/api/integration"].count, nativeHasFixture: true, loginProvidersHasFixture: hasLogin(facade) };
  assert.equal(after.loginProvidersHasFixture, false);
  await delay(100);
  stopEvents.abort();
  await streamState.done;
  assert.equal(streamState.error, undefined);
  await facade.close();
  facade = await OpencodeProviderAuthFacade.create(options);
  const reopenedHasFixture = hasLogin(facade);
  assert.equal(reopenedHasFixture, true);
  console.log(JSON.stringify({ version, before, after, reopenedHasFixture, events }, null, 2));
} finally {
  stopEvents.abort();
  release.resolve();
  await facade?.close();
  globalThis.fetch = realFetch;
  registry.closeAllConnections();
  const closed = once(registry, "close");
  registry.close();
  await closed;
  await rm(root, { recursive: true, force: true });
}
