import { isPiBackend, piChildCwd, piRpc, piSession } from "./support/pi-runtime.js";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { SessionManager } from "@earendil-works/pi-coding-agent";
import { describe, expect, test } from "vitest";
import { piInstallation, promptAndWait } from "../../packages/oar/src/index.js";
import { piSessionDir } from "../../packages/oar/src/runtimes/pi/resolve.js";
import { startPiAimock } from "../harness/aimock.js";
import { expectAvailable } from "./support/asserts.js";

/** SessionOptions.name (#368) as pi's own session list reports it. */
describe.skipIf(!isPiBackend)("pi session name", () => {
  test("a new session is named, a resume keeps the name it has, and names one that has none", async () => {
    const env = await startPiAimock((mock) => {
      mock.onMessage(/[\s\S]*/u, { content: "pong" });
    });
    const cwd = await mkdtemp(path.join(tmpdir(), "oar-pi-name-"));
    try {
      const installation = await piInstallation();
      expectAvailable(installation, "pi");
      const agentDir = process.env.OAR_PI_AGENT_DIR ?? "";
      const nativeCwd = piRpc ? piChildCwd(cwd) : cwd;
      const named = async (id: string): Promise<string | undefined> => {
        // Match the actual child's cwd; resolving links ourselves differs on Windows.
        const sessions = await SessionManager.list(nativeCwd, piSessionDir(cwd, agentDir));
        return sessions.find((info) => info.id === id)?.name;
      };

      const first = await piSession(installation, { cwd, name: "OAR vendor" });
      expect(await promptAndWait(first, "first")).toMatchObject({ kind: "ended", outcome: { kind: "completed" } });
      const id = first.id;
      await first.dispose();
      expect(await named(id)).toBe("OAR vendor");

      const resumed = await piSession(installation, { cwd, resume: id, name: "replacement" });
      expect(await promptAndWait(resumed, "again")).toMatchObject({ kind: "ended", outcome: { kind: "completed" } });
      await resumed.dispose();
      expect(await named(id)).toBe("OAR vendor");

      const unnamed = await piSession(installation, { cwd });
      await promptAndWait(unnamed, "unnamed");
      const unnamedId = unnamed.id;
      await unnamed.dispose();
      expect(await named(unnamedId)).toBeUndefined();
      const later = await piSession(installation, { cwd, resume: unnamedId, name: "named later" });
      await promptAndWait(later, "again");
      await later.dispose();
      expect(await named(unnamedId)).toBe("named later");
    } finally {
      await env.stop();
      await rm(cwd, { recursive: true, force: true, maxRetries: 5 });
    }
  }, 120_000);
});
