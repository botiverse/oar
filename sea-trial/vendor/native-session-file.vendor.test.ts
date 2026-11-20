import { stat } from "node:fs/promises";
import { isAbsolute } from "node:path";
import { expect, test } from "vitest";
import { codexRuntime, promptAndWait } from "../../packages/oar/src/index.js";
import { startCodexAimock, startPiAimock } from "../harness/aimock.js";
import { isPiBackend, piTestRuntime } from "./support/pi-runtime.js";

const codex = process.env.OAR_TEST === "codex-aimock";
interface FileIdentity { readonly dev: bigint; readonly ino: bigint }

// On Windows Codex can return the same rollout with a different path prefix on resume.
async function fileIdentity(path: string | null | undefined): Promise<FileIdentity> {
  if (typeof path !== "string") { throw new TypeError("missing native session file"); }
  expect(isAbsolute(path)).toBe(true);
  const status = await stat(path, { bigint: true });
  expect(status.isFile()).toBe(true);
  return { dev: status.dev, ino: status.ino };
}

test.skipIf(!codex && !isPiBackend)("locates the persisted root file on fresh, resumed and supported forked sessions", async () => {
  const runtime = codex ? codexRuntime : piTestRuntime;
  const installation = await runtime.installation();
  if (installation.kind !== "available") { throw new Error("fixture runtime unavailable"); }
  const fixture = codex ? await startCodexAimock() : await startPiAimock();
  try {
    const options = codex ? { cwd: process.cwd(), ...(fixture.env === undefined ? {} : { env: fixture.env }), model: "gpt-6.2-sol" } : { cwd: process.cwd(), model: "aimock/aimock-model" };
    let id: string | undefined = undefined;
    let source: FileIdentity | undefined = undefined;
    for (const mode of codex ? ["fresh", "resume", "fork"] : ["fresh", "resume"]) {
      const session = await runtime.session(installation, { ...options, ...(id === undefined ? {} : { resume: id }), ...(mode === "fork" ? { fork: {} } : {}) });
      try {
        const before = await session.nativeSessionFile?.();
        if (mode === "resume") { expect(await fileIdentity(before)).toEqual(source); }
        const turn = await promptAndWait(session, "save a turn", { timeoutMs: 30_000 });
        expect(turn.kind).toBe("ended");
        const file = await session.nativeSessionFile?.();
        const identity = await fileIdentity(file);
        expect(file).toContain(session.id);
        id ??= session.id;
        if (mode === "fresh") { source = identity; }
        else if (mode === "fork") { expect(identity).not.toEqual(source); }
        else { expect(identity).toEqual(source); }
      } finally { await session.dispose(); }
      expect(await session.nativeSessionFile?.()).toBeTruthy();
    }
  } finally { await fixture.stop(); }
}, 180_000);
