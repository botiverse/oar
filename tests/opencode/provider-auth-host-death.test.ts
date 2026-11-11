import { spawnSync } from "node:child_process";
import path from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { pathToFileURL } from "node:url";
import { afterEach, expect, test } from "vitest";
import { reportedPid } from "../fixtures/login-fixtures.js";
import { opencodeAuthFixture, removeOpencodeAuthFixtures } from "../fixtures/opencode-provider-auth.js";

/*
 * A host SIGKILLed while its facade's `opencode serve` runs runs no exit
 * hook, so only the watchdog the server runs under can stop it: the killed
 * host's end of its stdin pipe closes, and the watchdog stops the server.
 * Real processes: the host is a fresh node creating the facade over the fake
 * server, with an idle period far longer than the test.
 */

afterEach(removeOpencodeAuthFixtures);

const facadeUrl = pathToFileURL(path.join(import.meta.dirname, "../../packages/oar/src/runtimes/opencode/provider-auth-facade.ts")).href;

function alive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

async function gone(pid: number, ms: number): Promise<boolean> {
  const deadline = Date.now() + ms;
  while (alive(pid) && Date.now() < deadline) {
    // oxlint-disable-next-line no-await-in-loop -- polling.
    await delay(50);
  }
  return !alive(pid);
}

test("a SIGKILLed host's opencode serve stops with it", async () => {
  const { fake, home } = await opencodeAuthFixture();
  const options = { command: fake.command, env: { ...process.env, HOME: home, USERPROFILE: home }, cwd: home, timeoutMs: 10_000, loginTimeoutMs: 10_000, idleMs: 600_000, pollMs: 20, statusPollMs: 20, loopback: "allow" };
  const script = `import { OpencodeProviderAuthFacade } from ${JSON.stringify(facadeUrl)};
await OpencodeProviderAuthFacade.create(${JSON.stringify(options)});
process.kill(process.pid, "SIGKILL");`;
  const host = spawnSync(process.execPath, ["--import", "tsx", "--input-type=module", "-e", script], { encoding: "utf8", timeout: 30_000 });
  const server = reportedPid(fake, "serverPid");
  try {
    // Windows terminates the process outright (exit 1); the facade was created either way, or stderr says why not.
    expect(process.platform === "win32" ? { status: host.status, stderr: host.stderr } : { signal: host.signal, stderr: host.stderr })
      .toEqual(process.platform === "win32" ? { status: 1, stderr: "" } : { signal: "SIGKILL", stderr: "" });
    expect(await gone(server, 10_000), `opencode serve ${String(server)} outlived its killed host`).toBe(true);
  } finally {
    if (alive(server)) { process.kill(server, "SIGKILL"); }
  }
});
