/* oxlint-disable eslint/max-statements -- Keep the startup interleaving visible in each protocol regression. */
import assert from "node:assert/strict";
import { mkdir, mkdtemp, rename, rm, symlink } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, expect, test, vi } from "vitest";
import { codexSession } from "../../packages/oar/src/runtimes/codex/session.js";
import { startAppServerClient } from "../../packages/oar/src/runtimes/codex/app-server-client.js";
import { readFromAppServer } from "../../packages/oar/src/runtimes/codex/account-usage.js";
import { asRecord } from "../../packages/oar/src/shared/json.js";
import { fakeLineProcess, type FakeLineProcess } from "../fixtures/fake-line-process.js";

const spawnLineProcess = vi.hoisted(() => vi.fn<() => FakeLineProcess>());
vi.mock("../../packages/oar/src/shared/executable/index.js", () => ({ spawnLineProcess }));
const installation = { kind: "available", via: "executable", command: "codex" } as const;
const homes: string[] = [];
afterEach(async () => {
  spawnLineProcess.mockReset();
  vi.useRealTimers();
  vi.unstubAllEnvs();
  await Promise.all(homes.splice(0).map(async (home) => { await rm(home, { recursive: true, force: true }); }));
});

async function freshHome() {
  const home = await mkdtemp(path.join(tmpdir(), "oar-first-home-test-"));
  homes.push(home);
  return home;
}

/** Model the observed native failure: a second cold initializer cannot start. */
function coldNativeHome() {
  let initialized = false;
  let coldActive = false;
  const firstReady = Promise.withResolvers<() => void>();
  const children: FakeLineProcess[] = [];
  const replies: (() => void)[] = [];
  spawnLineProcess.mockImplementation(() => {
    const number = children.length + 1;
    const collides = !initialized && coldActive;
    if (!initialized) { coldActive = true; }
    const fake = fakeLineProcess((text, child) => {
      const message = asRecord(JSON.parse(text));
      if (typeof message?.id !== "number") { return; }
      if (collides) { child.emitStderr("sqlite initialization failed"); child.end(1); return; }
      const result = message.method === "initialize" ? {} : { thread: { id: `thread-${String(number)}` }, model: "gpt-5.5" };
      const reply = (): void => {
        const frames = [
          { id: message.id, result },
          ...(message.method === "thread/start" ? [{ method: "thread/started", params: { thread: { id: `thread-${String(number)}` } } }] : []),
        ];
        child.emit(frames.map((frame) => `${JSON.stringify(frame)}\n`).join(""));
      };
      if (message.method === "initialize" && !initialized) {
        const finish = (): void => { initialized = true; reply(); };
        replies.push(finish);
        firstReady.resolve(finish);
      } else { reply(); }
    });
    if (!collides) { fake.onExit(() => { coldActive = false; }); }
    children.push(fake);
    return fake;
  });
  return { children, replies, firstReady: firstReady.promise };
}

test("concurrent sessions on a fresh home wait for the first native initialization", async () => {
  const home = await freshHome();
  const native = coldNativeHome();
  const opening = Promise.allSettled(Array.from({ length: 8 }, async () => codexSession(installation, { cwd: home, env: { CODEX_HOME: home } })));
  const release = await native.firstReady;
  const beforeReady = native.children.length;
  release();
  const results = await opening;
  await Promise.all(results.map(async (result) => {
    if (result.status === "fulfilled") {
      // Waiting must not move the open marker past a same-chunk notification.
      expect(result.value.records().slice(0, 2).map((record) => record.kind === "frame" ? record.body.type : record.kind))
        .toEqual(["thread/start", "thread/started"]);
      await result.value.dispose();
    }
  }));
  expect({ beforeReady, opened: results.map((result) => result.status) }).toMatchInlineSnapshot(`
    {
      "beforeReady": 1,
      "opened": [
        "fulfilled",
        "fulfilled",
        "fulfilled",
        "fulfilled",
        "fulfilled",
        "fulfilled",
        "fulfilled",
        "fulfilled",
      ],
    }
  `);
});

test("a queued client can be killed without spawning later or blocking the initializer", async () => {
  const home = await freshHome();
  const native = coldNativeHome();
  const first = startAppServerClient("codex", { CODEX_HOME: home });
  const initialize = first.request("initialize", {});
  const queued = startAppServerClient("codex", { CODEX_HOME: home });
  const failed = expect(queued.request("initialize", {})).rejects.toThrow("cancelled before spawn");
  queued.kill();
  await failed;
  expect(await queued.exited).toBeNull();
  (await native.firstReady)();
  await initialize;
  first.notify("initialized", {});
  expect(native.children.length).toBe(1);
  first.kill();
});

test("an initializer's unexpected exit releases its home without marking it ready", async () => {
  const home = await freshHome();
  const native = coldNativeHome();
  const first = startAppServerClient("codex", { CODEX_HOME: home });
  const failed = expect(first.request("initialize", {})).rejects.toThrow("app-server exited");
  const second = startAppServerClient("codex", { CODEX_HOME: home });
  const succeeding = second.request("initialize", {});
  native.children[0]?.end(1);
  await failed;
  await vi.waitFor(() => { expect(native.replies.length).toBe(2); });
  const [, reply] = native.replies;
  assert.ok(reply !== undefined);
  reply();
  await succeeding;
  second.notify("initialized", {});
  expect(native.children.length).toBe(2);
  second.kill();
});

test("a rejected initialize waits for process exit before starting the next initializer", async () => {
  const home = await freshHome();
  const native = coldNativeHome();
  const first = startAppServerClient("codex", { CODEX_HOME: home });
  const [child] = native.children;
  assert.ok(child !== undefined);
  const kill = vi.spyOn(child, "kill").mockImplementation(() => {});
  const failed = expect(first.request("initialize", {})).rejects.toThrow("native initialization failed");
  const second = startAppServerClient("codex", { CODEX_HOME: home });
  const third = startAppServerClient("codex", { CODEX_HOME: home });
  child.emit(`${JSON.stringify({ id: 1, error: { message: "native initialization failed" } })}\n`);
  await vi.waitFor(() => { expect(kill).toHaveBeenCalledOnce(); });
  expect(native.children.length).toBe(1);
  child.end(1);
  await failed;
  expect(native.children.length).toBe(2);
  third.kill();
  second.kill();
});

test("different homes do not wait for one another", async () => {
  const [home, other] = await Promise.all([freshHome(), freshHome()]);
  const native = coldNativeHome();
  const first = startAppServerClient("codex", { CODEX_HOME: home });
  const second = startAppServerClient("codex", { CODEX_HOME: other });
  expect(native.children.length).toBe(2);
  first.kill();
  second.kill();
});

test.each(["relative", "trailing-separator", "symlink"])("a %s home alias shares the same initialization gate", async (kind) => {
  const [home, parent] = await Promise.all([freshHome(), freshHome()]);
  let alias = path.join(parent, "alias");
  if (kind === "relative") { alias = path.basename(home); }
  else if (kind === "trailing-separator") { alias = `${home}${path.sep}`; }
  else { await symlink(home, alias, "junction"); }
  const native = coldNativeHome();
  const first = startAppServerClient("codex", { CODEX_HOME: home });
  const second = startAppServerClient("codex", { CODEX_HOME: alias }, {}, path.dirname(home));
  expect(native.children.length).toBe(1);
  second.kill();
  first.kill();
});

test("later clients on an initialized home start concurrently", async () => {
  const home = await freshHome();
  const native = coldNativeHome();
  const first = startAppServerClient("codex", { CODEX_HOME: home });
  const initialize = first.request("initialize", {});
  const second = startAppServerClient("codex", { CODEX_HOME: home });
  (await native.firstReady)();
  await initialize;
  // The response alone does not release the next process before initialized.
  expect(native.children.length).toBe(1);
  first.notify("initialized", {});
  first.kill();
  const third = startAppServerClient("codex", { CODEX_HOME: home });
  expect(native.children.length).toBe(3);
  second.kill();
  third.kill();
});

test("an account query keeps its existing deadline while queued for initialization", async () => {
  const home = await freshHome();
  vi.stubEnv("CODEX_HOME", home);
  vi.useFakeTimers();
  const native = coldNativeHome();
  const first = startAppServerClient("codex");
  const usage = readFromAppServer("codex", 321);
  await vi.advanceTimersByTimeAsync(321);
  expect(await usage).toMatchInlineSnapshot(`
    {
      "kind": "error",
    }
  `);
  expect(native.children.length).toBe(1);
  first.kill();
  expect(native.children.length).toBe(1);
});

test("replacing a home at the same path invalidates observed readiness", async () => {
  const parent = await freshHome();
  const home = path.join(parent, "home");
  await mkdir(home);
  const native = coldNativeHome();
  const first = startAppServerClient("codex", { CODEX_HOME: home });
  const initialize = first.request("initialize", {});
  (await native.firstReady)();
  await initialize;
  first.notify("initialized", {});
  first.kill();
  await rename(home, path.join(parent, "old"));
  await mkdir(home);
  const second = startAppServerClient("codex", { CODEX_HOME: home });
  const third = startAppServerClient("codex", { CODEX_HOME: home });
  expect(native.children.length).toBe(2);
  third.kill();
  second.kill();
});
