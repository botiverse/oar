import { spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { expect, test } from "vitest";
import { agentTreeModule, fakeAgentBinary, gone, withTreeProbe } from "./fixtures/process-tree.js";

const claudeModule = new URL("../packages/oar/src/runtimes/claude/session.ts", import.meta.url).href;
const executableModule = new URL("../packages/oar/src/shared/executable/index.ts", import.meta.url).href;
const loginModule = new URL("../packages/oar/src/shared/login.ts", import.meta.url).href;
const terminalModule = new URL("../packages/oar/src/shared/acp/terminal.ts", import.meta.url).href;

// No dispose/finally in the host: this tests the synchronous process exit
// hook, including tools in both groups, independently of session shutdown.
test.skipIf(process.platform === "win32").each(["probe", "isolated", "login", "terminal"])(
  "host exit kills a live session and a hung %s process group",
  async (kind) => {
    await withTreeProbe({ ignoreSigterm: true }, async (sessionProbe) => {
      await withTreeProbe({ ignoreSigterm: true }, async (otherProbe) => {
        const source = `
          import { existsSync } from "node:fs";
          import { setTimeout as delay } from "node:timers/promises";
          import { claudeSession } from ${JSON.stringify(claudeModule)};
          import { runExecutable, runIsolated } from ${JSON.stringify(executableModule)};
          import { spawnLoginProcess } from ${JSON.stringify(loginModule)};
          import { createAcpTerminalHost } from ${JSON.stringify(terminalModule)};
          await claudeSession({ kind: "available", via: "executable", command: ${JSON.stringify(fakeAgentBinary(sessionProbe.dir))}, version: "test" }, {
            cwd: ${JSON.stringify(sessionProbe.dir)}, env: ${JSON.stringify(sessionProbe.env)}
          });
          const env = { ...process.env, ...${JSON.stringify(otherProbe.env)} };
          const args = ["--import", ${JSON.stringify(agentTreeModule)}, "-e", "setInterval(() => {}, 1000)"];
          switch (${JSON.stringify(kind)}) {
            case "probe": void runExecutable(process.execPath, args, { env, timeoutMs: 60_000 }); break;
            case "isolated": void runIsolated(process.execPath, args, { env, timeoutMs: 60_000 }); break;
            case "login": spawnLoginProcess(process.execPath, args, env, { onLine() {} }); break;
            case "terminal": await createAcpTerminalHost(process.cwd(), env).create({ sessionId: "host-exit", command: process.execPath, args }); break;
          }
          const deadline = Date.now() + 10_000;
          while (!${JSON.stringify([sessionProbe.env.OAR_FIXTURE_PIDS, otherProbe.env.OAR_FIXTURE_PIDS])}.every(existsSync)) {
            if (Date.now() > deadline) throw new Error("children did not start");
            await delay(20);
          }
          process.exit(23);
        `;
        const host = spawnSync(process.execPath, ["--import", "tsx", "--input-type=module", "-e", source], { encoding: "utf8", timeout: 20_000 });
        // Read before asserting: withTreeProbe must know every pid to clean
        // up even when the regression fails.
        const trees = await Promise.all([sessionProbe.tree(), otherProbe.tree()]);
        expect(host.error).toBeUndefined();
        expect(host.stderr).toBe("");
        expect(host.status).toBe(23);
        const pids = trees.flatMap(({ agent, grandchild }) => [agent, grandchild]);
        expect(await Promise.all(pids.map(async (pid) => gone(pid))), `surviving children: ${JSON.stringify(trees)}`)
          .toEqual([true, true, true, true]);
      });
    });
  },
);


// Includes Windows: its exit hook promises direct-child termination only.
// oxlint-disable-next-line eslint/max-statements -- Spawn, observe and reclaim the same host and its two children.
test("host exit kills its live transport and one-shot child on every platform", async () => {
  const dir = mkdtempSync(path.join(tmpdir(), "oar-host-exit-"));
  const files = [path.join(dir, "session.pid"), path.join(dir, "probe.pid")];
  const children: number[] = [];
  try {
    const source = `
      import { existsSync } from "node:fs";
      import { setTimeout as delay } from "node:timers/promises";
      import { runExecutable, spawnLineProcess } from ${JSON.stringify(executableModule)};
      const files = ${JSON.stringify(files)};
      const child = "const fs = require('node:fs'); const file = process.argv[1]; fs.writeFileSync(file + '.tmp', String(process.pid)); fs.renameSync(file + '.tmp', file); setInterval(() => {}, 1000)";
      await spawnLineProcess(process.execPath, ["-e", child, files[0]]).spawned;
      void runExecutable(process.execPath, ["-e", child, files[1]], { timeoutMs: 60_000 });
      const deadline = Date.now() + 10_000;
      while (!files.every(existsSync)) {
        if (Date.now() > deadline) throw new Error("children did not start");
        await delay(20);
      }
      process.exit(23);
    `;
    const host = spawnSync(process.execPath, ["--import", "tsx", "--input-type=module", "-e", source], { encoding: "utf8", timeout: 20_000 });
    children.push(...files.map((file) => Number(readFileSync(file, "utf8"))));
    expect(host.error).toBeUndefined();
    expect(host.stderr).toBe("");
    expect(host.status).toBe(23);
    expect(await Promise.all(children.map(async (pid) => gone(pid)))).toEqual([true, true]);
  } finally {
    for (const pid of children) {
      try { process.kill(pid, "SIGKILL"); } catch { /* Already gone. */ }
    }
    rmSync(dir, { recursive: true, force: true });
  }
});
