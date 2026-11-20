import { stat } from "node:fs/promises";
import { isAbsolute } from "node:path";
import { expect, test } from "vitest";
import { codexRuntime, promptAndWait } from "../../packages/oar/src/index.js";
import { startCodexAimock, startPiAimock } from "../harness/aimock.js";
import { isPiBackend, piTestRuntime } from "./support/pi-runtime.js";

const codex = process.env.OAR_TEST === "codex-aimock";
test.skipIf(!codex && !isPiBackend)("locates the persisted root file on fresh, resumed and supported forked sessions", async () => {
  const runtime = codex ? codexRuntime : piTestRuntime;
  const installation = await runtime.installation();
  if (installation.kind !== "available") { throw new Error("fixture runtime unavailable"); }
  const fixture = codex ? await startCodexAimock() : await startPiAimock();
  try {
    const options = codex ? { cwd: process.cwd(), ...(fixture.env === undefined ? {} : { env: fixture.env }), model: "gpt-6.2-sol" } : { cwd: process.cwd(), model: "aimock/aimock-model" };
    let id: string | undefined = undefined;
    let source: string | null = null;
    for (const mode of codex ? ["fresh", "resume", "fork"] : ["fresh", "resume"]) {
      const session = await runtime.session(installation, { ...options, ...(id === undefined ? {} : { resume: id }), ...(mode === "fork" ? { fork: {} } : {}) });
      try {
        const before = await session.nativeSessionFile?.();
        if (mode === "resume") { expect(before).toBe(source); }
        const turn = await promptAndWait(session, "save a turn", { timeoutMs: 30_000 });
        expect(turn.kind).toBe("ended");
        const file = await session.nativeSessionFile?.();
        if (typeof file !== "string") { throw new TypeError("missing native session file after a completed turn"); }
        expect(isAbsolute(file)).toBe(true);
        const status = await stat(file);
        expect(status.isFile()).toBe(true);
        expect(file).toContain(session.id);
        id ??= session.id;
        source ??= file;
        if (mode === "fork") { expect(file).not.toBe(source); }
        else { expect(file).toBe(source); }
      } finally { await session.dispose(); }
      expect(await session.nativeSessionFile?.()).toBeTruthy();
    }
  } finally { await fixture.stop(); }
}, 180_000);
