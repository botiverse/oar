/* oxlint-disable eslint/max-statements -- Keep ownership and cancellation in their observed order. */
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { expect, onTestFinished, test } from "vitest";
import { acquireDshProfile } from "../../packages/oar/src/runtimes/dsh/profile-startup.js";

async function fixture() {
  const cwd = await mkdtemp(path.join(tmpdir(), "oar-dsh-cold-profile-"));
  onTestFinished(async () => { await rm(cwd, { recursive: true, force: true }); });
  const manifest = path.join(cwd, "native", "profiles", "acp", "package.json");
  const acquire = async (home = "native", signal = AbortSignal.timeout(5000)) => acquireDshProfile({ DSH_HOME: home }, cwd, signal);
  return { cwd, manifest, acquire };
}

test("a failed first DSH startup hands the profile to one waiter and a cancelled waiter never starts", async () => {
  const { cwd, acquire } = await fixture();
  const first = await acquire();
  const controller = new AbortController();
  const queued = acquire(path.join(cwd, "native"), controller.signal);
  controller.abort(new Error("query expired"));
  await expect(queued).rejects.toThrow("query expired");
  let started = false;
  const next = async () => { const finish = await acquire(); started = true; return finish; };
  const second = next();
  const other = await acquire("independent");
  expect(started).toBe(false);
  first(false);
  (await second)(false);
  other(false);
});

test("DSH permits warm opens concurrently and coordinates again after the manifest disappears", async () => {
  const { acquire, manifest } = await fixture();
  const first = await acquire();
  await mkdir(path.dirname(manifest), { recursive: true });
  await writeFile(manifest, "{}");
  first(true);
  const warm = await Promise.all([acquire(), acquire()]);
  warm.forEach(finish => { finish(true); });
  await rm(manifest);
  const owner = await acquire();
  const controller = new AbortController();
  const waiting = acquire("native", controller.signal);
  controller.abort(new Error("waiting for replacement profile"));
  await expect(waiting).rejects.toThrow("waiting for replacement profile");
  owner(false);
});
