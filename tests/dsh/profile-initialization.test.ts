/* oxlint-disable eslint/max-statements -- Keep lock ownership, cancellation and process death in observable order. */
import { spawn } from "node:child_process";
import { once } from "node:events";
import { access, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { expect, onTestFinished, test, vi } from "vitest";
import { dshRuntime } from "../../packages/oar/src/runtimes/dsh/index.js";
import { DSH_READY_TIMEOUT_MS } from "../../packages/oar/src/runtimes/dsh/control.js";
import { fakeAgentBinary } from "../fixtures/process-tree.js";
import { acquireDshProfile } from "../../packages/oar/src/runtimes/dsh/profile-startup.js";

async function fixture() {
  const cwd = await mkdtemp(path.join(tmpdir(), "oar-dsh-profile-"));
  onTestFinished(async () => { await rm(cwd, { recursive: true, force: true }); });
  const acquire = async (home = "native", signal = AbortSignal.timeout(5000)) => acquireDshProfile({ DSH_HOME: home }, cwd, signal);
  return { cwd, acquire };
}

test("cold and warm starts both exclude same-profile peers while independent profiles can open", async () => {
  const { cwd, acquire } = await fixture();
  const first = await acquire();
  await writeFile(path.join(cwd, "native", "profiles", "acp", "package.json"), "{}");
  const other = await acquire("independent");
  other();
  await expect(acquire(path.join(cwd, "native"), AbortSignal.timeout(80))).rejects.toMatchObject({ name: "TimeoutError" });
  first();
  const warm = await acquire();
  const controller = new AbortController();
  const waiting = acquire("native", controller.signal);
  controller.abort(new Error("query expired"));
  await expect(waiting).rejects.toThrow("query expired");
  first(); // A second release from the exited child cannot unlock the new owner.
  await expect(acquire("native", AbortSignal.timeout(80))).rejects.toMatchObject({ name: "TimeoutError" });
  warm();
  (await acquire())();
});

test("the OS releases the startup lock when another OAR process dies before it loads the profile", async () => {
  const { cwd, acquire } = await fixture();
  const module = new URL("../../packages/oar/src/runtimes/dsh/profile-startup.ts", import.meta.url).href;
  const script = `
    import { acquireDshProfile } from ${JSON.stringify(module)};
    const release = await acquireDshProfile({ DSH_HOME: "native" }, process.argv[1]);
    process.on("disconnect", () => { release(); process.exit(); });
    process.send("holding");
  `;
  const holder = spawn(process.execPath, ["--import", "tsx", "--input-type=module", "-e", script, cwd], { stdio: ["ignore", "ignore", "inherit", "ipc"] });
  const exited = once(holder, "exit");
  try {
    await Promise.race([once(holder, "message"), exited.then(() => { throw new Error("holder exited before acquiring the lock"); })]);
    await expect(acquire("native", AbortSignal.timeout(100))).rejects.toMatchObject({ name: "TimeoutError" });
    const next = acquire();
    holder.kill("SIGKILL");
    await exited;
    (await next)();
  } finally {
    if (holder.exitCode === null && holder.signalCode === null) { holder.kill("SIGKILL"); }
    await exited;
  }
});

test("a queued query names the profile lock and elapsed wait at its own deadline", async () => {
  const { cwd, acquire } = await fixture();
  const release = await acquire();
  const installation = { kind: "available", via: "executable", command: "unused", version: "0.2.1-rc.5" } as const;
  const options = { cwd, env: { DSH_HOME: "native" }, timeoutMs: 30_000 };
  const directory = path.join(cwd, "native", "profiles", "acp");
  const acquisitions = vi.spyOn(await import("../../packages/oar/src/runtimes/dsh/profile-startup.js"), "acquireDshProfile");
  vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
  try {
    const queries = Promise.allSettled([
      dshRuntime.listModels(installation, options),
      dshRuntime.skills(installation, options),
    ]);
    // Filesystem setup precedes contention. Expire the queries only once both have seen the held lock.
    try {
      await expect.poll(() => acquisitions.mock.calls.map(call => call[3]?.blocked?.directory),
        { timeout: 10_000 }).toEqual([directory, directory]);
    } finally { vi.advanceTimersByTime(options.timeoutMs); }
    const [models, skills] = await queries;
    expect(models).toMatchObject({ status: "rejected", reason: { name: "TimeoutError" } });
    expect(skills).toMatchObject({ status: "fulfilled", value: { kind: "unavailable", code: "timeout" } });
    const modelReason = models.status === "rejected" ? String(models.reason) : "";
    const skillReason = skills.status === "fulfilled" && skills.value.kind === "unavailable" ? skills.value.reason : "";
    for (const reason of [modelReason, skillReason]) {
      expect(reason).toContain(directory);
      expect(reason).toMatch(/Waited \d+ ms for another DSH start/u);
    }
  } finally { vi.useRealTimers(); acquisitions.mockRestore(); release(); }
});

test("a holder that never imports the bridge is stopped at its ready deadline and the next start opens", async () => {
  const { cwd, acquire } = await fixture();
  const marker = path.join(cwd, "started");
  const command = fakeAgentBinary(cwd, [path.resolve(import.meta.dirname, "../fixtures/fake-dsh.mjs")]);
  const installation = { kind: "available", via: "executable", command, version: "0.2.1-rc.5" } as const;
  const env = { DSH_HOME: "native" };
  vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
  try {
    const failure = expect(dshRuntime.session(installation, { cwd, env: { ...env, FAKE_DSH_HOLD_BEFORE_PROFILE: marker } })).rejects.toThrow("did not load the OAR bridge");
    await vi.waitFor(async () => access(marker), { timeout: 5000 });
    await expect(acquire("native", AbortSignal.timeout(100))).rejects.toMatchObject({ name: "TimeoutError" });
    const next = dshRuntime.session(installation, { cwd, env });
    vi.advanceTimersByTime(DSH_READY_TIMEOUT_MS);
    vi.useRealTimers();
    await failure;
    const session = await next;
    await session.dispose();
  } finally { vi.useRealTimers(); }
});
