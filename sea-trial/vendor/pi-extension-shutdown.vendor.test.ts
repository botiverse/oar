import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { describe, expect, test, vi } from "vitest";
import { defineRuntime, piInstallation, piSession, type Session } from "../../packages/oar/src/index.js";
import { startPiAimock } from "../harness/aimock.js";
import { runtimeUnderTest } from "../harness/subject.js";

const runtime = defineRuntime({ id: "pi-aimock", session: piSession, installation: piInstallation });

async function installHangingExtension(): Promise<void> {
  const agentDir = process.env.OAR_PI_AGENT_DIR;
  if (agentDir === undefined) {
    throw new Error("startPiAimock sets OAR_PI_AGENT_DIR");
  }
  const extensions = path.join(agentDir, "extensions");
  await mkdir(extensions, { recursive: true });
  await writeFile(path.join(extensions, "hanging-shutdown.ts"), `
export default (pi) => {
  pi.on("session_shutdown", () => new Promise(() => {}));
};
`);
}

/** Fail a stuck dispose without letting the test itself wait forever. */
async function settlesWithin(disposal: Promise<void>, timeoutMs: number): Promise<boolean> {
  let timer: ReturnType<typeof setTimeout> | undefined = undefined;
  try {
    return await Promise.race([
      disposal.then(() => true),
      new Promise<boolean>((resolve) => { timer = setTimeout(() => { resolve(false); }, timeoutMs); }),
    ]);
  } finally {
    clearTimeout(timer);
  }
}

describe.skipIf(process.env.OAR_TEST !== "pi-aimock")("pi extension shutdown deadline", () => {
  test("a never-settling user hook warns and releases the native session after ten seconds", async () => {
    const env = await startPiAimock();
    const { AgentSession } = await import("@earendil-works/pi-coding-agent");
    const disposed = vi.spyOn(AgentSession.prototype, "dispose");
    const warning = vi.spyOn(process, "emitWarning").mockImplementation(() => {});
    let session: Session | undefined = undefined;
    try {
      await installHangingExtension();
      session = await runtimeUnderTest(runtime, env.env).startSession();
      const before = performance.now();
      expect(await settlesWithin(session.dispose(), 12_000)).toBe(true);
      expect(performance.now() - before).toBeGreaterThanOrEqual(10_000);
      expect(disposed).toHaveBeenCalledOnce();
      expect(warning.mock.calls).toEqual([[
        `pi session_shutdown hooks timed out after 10000 ms for session ${session.id}; releasing the session without waiting for remaining hooks`,
        { code: "OAR_PI_SHUTDOWN_TIMEOUT" },
      ]]);
      expect(session.records().at(-1)).toMatchObject({ kind: "response", body: { kind: "accepted" } });
      await session.dispose();
      expect(disposed).toHaveBeenCalledOnce();
      expect(warning).toHaveBeenCalledOnce();
    } finally {
      await session?.dispose();
      disposed.mockRestore();
      warning.mockRestore();
      await env.stop();
    }
  }, 30_000);
});
