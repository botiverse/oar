/* oxlint-disable no-await-in-loop -- Isolate each native lifecycle timeline from other probe processes. */
import assert from "node:assert/strict";
import { writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { setTimeout as sleep } from "node:timers/promises";
import { sessionEnvironment } from "../../packages/oar/src/shared/environment.js";
import { withQueryDeadline } from "../../packages/oar/src/shared/executable/query.js";
import { startKimiWeb } from "../../packages/oar/src/runtimes/kimi/web-startup.js";
import { stopKimiWeb, KIMI_WEB_SHUTDOWN_GRACE_MS } from "../../packages/oar/src/runtimes/kimi/web-shutdown.js";
import { kimiWebRequest } from "../../packages/oar/src/runtimes/kimi/web-query.js";
import { kimiExpiredUsageFixture } from "../../sea-trial/vendor/support/kimi-expired-usage.js";

async function awaitRefresh(calls: readonly { path: string }[]): Promise<void> {
  const limit = Date.now() + 30_000;
  while (!calls.some(call => call.path === "/api/oauth/token")) { assert.ok(Date.now() < limit, "refresh not observed"); await sleep(10); }
}

const [command, output] = process.argv.slice(2);
assert.ok(command !== undefined && command !== "" && output !== undefined && output !== "", "usage: shutdown.ts /absolute/path/to/kimi output.json");
const rows: unknown[] = [];
for (const mode of ["cancel-kill", "cancel-shutdown", "deadline-shutdown", "deadline-exceeds-grace"]) {
  for (let round = 0; round < 3; round++) {
    const delayMs = mode === "deadline-exceeds-grace" ? 4000 : 600;
    const fixture = await kimiExpiredUsageFixture("success", delayMs);
    const controller = new AbortController(); const startupTimer = setTimeout(() => { controller.abort(); }, 30_000);
    const owner: { started?: Awaited<ReturnType<typeof startKimiWeb>> } = {};
    try {
      await writeFile(join(fixture.home, "server.token"), "synthetic-local-server-token", { mode: 0o600 });
      owner.started = await startKimiWeb(resolve(command), sessionEnvironment(fixture.env), controller.signal, fixture.dir);
      clearTimeout(startupTimer);
      const { child, web } = owner.started;
      const start = performance.now(); let answer = "unobserved";
      if (mode.startsWith("deadline")) {
        await withQueryDeadline("Kimi probe", 50, async signal => {
          try { await kimiWebRequest(web, signal, "/oauth/usage"); }
          finally { await stopKimiWeb(child, web); }
        }).catch(() => { answer = "deadline"; });
      } else {
        const request = async (): Promise<void> => { try { await kimiWebRequest(web, controller.signal, "/oauth/usage"); } catch { answer = "cancelled"; } };
        // oxlint-disable-next-line unicorn/prefer-top-level-await -- Cancel only after the native refresh reaches the synthetic provider.
        const pending = request();
        await awaitRefresh(fixture.calls);
        controller.abort(); await pending;
      }
      const answerAt = performance.now();
      assert.equal(fixture.calls.filter(call => call.path === "/api/oauth/token").length, 1, "refresh must have started before cancellation");
      const killedAtAnswer = child.stopping();
      if (mode === "cancel-kill") { child.kill(); }
      else if (mode === "cancel-shutdown") { await stopKimiWeb(child, web); }
      const exitCode = await child.exited;
      rows.push({ mode, round, refreshReplyDelayMs: delayMs, answer, answerMs: answerAt - start, killedAtAnswer,
        cleanupAfterAnswerMs: performance.now() - answerAt, killed: child.stopping(), exitCode, observation: await fixture.observe() });
      await writeFile(output, JSON.stringify({ graceMs: KIMI_WEB_SHUTDOWN_GRACE_MS, queryDeadlineMs: 50, rows }, null, 2));
    } finally {
      clearTimeout(startupTimer);
      if (owner.started !== undefined) { owner.started.child.kill(); await owner.started.child.exited; }
      await fixture.dispose();
    }
  }
}
