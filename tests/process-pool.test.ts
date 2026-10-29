import { expect, test, vi } from "vitest";
import { createProcessPool, type ProcessConfiguration } from "../packages/oar/src/shared/process-pool.js";

const config: ProcessConfiguration = { command: "/runtime", args: ["serve"], env: { HOME: "/one", TOKEN: "synthetic-secret" }, home: "/one", configDirectories: ["/one/.config"] };
function processFixture() {
  const exit = Promise.withResolvers<number | null>();
  return { exited: exit.promise, exit: exit.resolve, stop: vi.fn(() => { exit.resolve(0); }),
    resources: async () => { await Promise.resolve(); return { rss: 100, processes: 2 }; } };
}

// oxlint-disable-next-line eslint/max-statements -- Keep the ownership transitions and their observations in one chronological regression.
test("concurrent shared acquisition waits for one startup; last disposal stops it once", async () => {
  const started = Promise.withResolvers<ReturnType<typeof processFixture>>();
  const start = vi.fn(async () => started.promise);
  const pool = createProcessPool(start);
  const first = pool.acquire(config, "shared");
  const second = pool.acquire({ ...config, env: { TOKEN: "synthetic-secret", HOME: "/one" } }, "shared");
  const process = processFixture();
  started.resolve(process);
  const [a, b] = await Promise.all([first, second]);
  expect(start).toHaveBeenCalledTimes(1);
  expect(a.process).toBe(b.process);
  expect(await a.resources()).toMatchInlineSnapshot(`
    {
      "processes": 2,
      "rss": 100,
      "scope": "shared_process",
    }
  `);
  await expect(a.dispose()).resolves.toBe("released");
  await expect(a.dispose()).resolves.toBe("released");
  expect(process.stop).not.toHaveBeenCalled();
  await expect(b.dispose()).resolves.toBe("exited");
  await b.dispose();
  expect(process.stop).toHaveBeenCalledTimes(1);
});

test.each([
  { command: "/another" }, { args: ["serve", "--flag"] }, { env: { HOME: "/one", TOKEN: "different" } },
  { home: "/two" }, { configDirectories: ["/two/.config"] }, { cwd: "/process-cwd" },
])("a changed process input starts a distinct process: %j", async (different) => {
  const start = vi.fn(async () => { await Promise.resolve(); return processFixture(); });
  const pool = createProcessPool(start);
  const a = await pool.acquire(config, "shared");
  const b = await pool.acquire({ ...config, ...different }, "shared");
  expect(start).toHaveBeenCalledTimes(2);
  expect(a.process).not.toBe(b.process);
  await Promise.all([a.dispose(), b.dispose()]);
});

test("independent pools and explicit isolated leases never coalesce", async () => {
  const start = vi.fn(async () => { await Promise.resolve(); return processFixture(); });
  const one = createProcessPool(start);
  const two = createProcessPool(start);
  const leases = await Promise.all([one.acquire(config, "shared"), two.acquire(config, "shared"), one.acquire(config, "isolated"), one.acquire(config, "isolated")]);
  expect(new Set(leases.map((lease) => lease.process)).size).toBe(4);
  expect(await leases[2].resources()).toEqual({ rss: 100, processes: 2 });
  await Promise.all(leases.map(async (lease) => lease.dispose()));
});

test("configuration is captured before asynchronous startup", async () => {
  const changing = { command: "/runtime", args: ["serve"], env: { HOME: "/one" }, configDirectories: ["/one"] };
  const start = vi.fn(async (_configuration: ProcessConfiguration) => { await Promise.resolve(); return processFixture(); });
  const pool = createProcessPool(start);
  const waiting = pool.acquire(changing, "shared");
  changing.args.push("--different"); changing.env.HOME = "/two"; changing.configDirectories.push("/two");
  const lease = await waiting;
  expect(start.mock.calls[0]?.[0]).toEqual({ command: "/runtime", args: ["serve"], env: { HOME: "/one" }, configDirectories: ["/one"] });
  await lease.dispose();
});

// oxlint-disable-next-line eslint/max-statements -- Keep the ownership transitions and their observations in one chronological regression.
test("failed startup is evicted; active process exit never silently restarts leases", async () => {
  const error = new Error("startup failed");
  const start = vi.fn(async () => { await Promise.resolve(); return processFixture(); }).mockRejectedValueOnce(error);
  const pool = createProcessPool(start);
  await expect(pool.acquire(config, "shared")).rejects.toBe(error);
  const a = await pool.acquire(config, "shared");
  const b = await pool.acquire(config, "shared");
  a.process.exit(9);
  await a.process.exited;
  expect(start).toHaveBeenCalledTimes(2);
  expect(b.process).toBe(a.process);
  const next = await pool.acquire(config, "shared");
  expect(next.process).not.toBe(a.process);
  await Promise.all([a.dispose(), b.dispose(), next.dispose()]);
});

// oxlint-disable-next-line eslint/max-statements -- Keep the ownership transitions and their observations in one chronological regression.
test("opening while the last owner is closing creates a fresh generation", async () => {
  const closed = Promise.withResolvers<void>();
  const start = vi.fn(async () => {
    await Promise.resolve();
    const process = processFixture();
    return { ...process, stop: async () => { await closed.promise; process.exit(0); } };
  });
  const pool = createProcessPool(start);
  const old = await pool.acquire(config, "shared");
  const ending = old.dispose();
  const next = await pool.acquire(config, "shared");
  expect(next.process).not.toBe(old.process);
  closed.resolve();
  await ending;
  const joined = await pool.acquire(config, "shared");
  expect(joined.process).toBe(next.process);
  await Promise.all([next.dispose(), joined.dispose()]);
});


test("observed exit makes resources absent and disposal never stops the dead process again", async () => {
  const pool = createProcessPool(async () => { await Promise.resolve(); return processFixture(); });
  const a = await pool.acquire(config, "shared");
  const b = await pool.acquire(config, "shared");
  a.process.exit(7); await a.process.exited;
  expect(await a.resources()).toBeNull();
  expect(await b.resources()).toBeNull();
  await expect(a.dispose()).resolves.toBe("exited");
  await expect(b.dispose()).resolves.toBe("exited");
  expect(a.process.stop).not.toHaveBeenCalled();
});

// oxlint-disable-next-line max-statements -- Follow failed shutdown, new acquisition and retry across two process generations.
test("failed shutdown retains its owner for retry without accepting new leases", async () => {
  const start = vi.fn(async () => { await Promise.resolve(); return processFixture(); });
  const pool = createProcessPool(start);
  const old = await pool.acquire(config, "shared");
  old.process.stop.mockImplementationOnce(() => { throw new Error("stop failed"); });
  const attempts = await Promise.allSettled([old.dispose(), old.dispose()]);
  expect(attempts.map((attempt) => attempt.status)).toEqual(["rejected", "rejected"]);
  expect(old.process.stop).toHaveBeenCalledTimes(1);
  expect(await old.resources()).not.toBeNull();
  const next = await pool.acquire(config, "shared");
  expect(next.process).not.toBe(old.process);
  await expect(old.dispose()).resolves.toBe("exited");
  expect(old.process.stop).toHaveBeenCalledTimes(2);
  expect(next.process.stop).not.toHaveBeenCalled();
  await next.dispose();
});

test("exit observers can release their reference without waiting for process death", async () => {
  const pool = createProcessPool(async () => { await Promise.resolve(); return processFixture(); });
  const lease = await pool.acquire(config, "shared");
  const removed = vi.fn<(code: number | null) => void>(); const retained = vi.fn<(code: number | null) => void>();
  const unsubscribe = lease.onExit(removed);
  lease.onExit(retained);
  unsubscribe();
  await lease.dispose();
  expect(removed).not.toHaveBeenCalled();
  expect(retained).toHaveBeenCalledExactlyOnceWith(0);
});
