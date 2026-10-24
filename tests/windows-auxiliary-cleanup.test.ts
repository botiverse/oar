import { setTimeout as delay } from "node:timers/promises";
import { fileURLToPath } from "node:url";
import { expect, test } from "vitest";
import { createAcpTerminalHost, type AcpTerminalHost } from "../packages/oar/src/shared/acp/terminal.js";
import { runExecutable } from "../packages/oar/src/shared/executable/run.js";
import { spawnLoginProcess } from "../packages/oar/src/shared/login.js";
import { fakeAgentBinary, gone, withTreeProbe } from "./fixtures/process-tree.js";

const fixture = fileURLToPath(new URL("fixtures/probe-background-child.mjs", import.meta.url));
const windowsTest = test.skipIf(process.platform !== "win32");

async function bounded<Result>(result: Promise<Result>): Promise<Result | null> {
  const controller = new AbortController();
  try {
    return await Promise.race([result, delay(6000, null, { signal: controller.signal })]);
  } finally {
    controller.abort();
  }
}

async function stopTerminal(
  terminal: AcpTerminalHost,
  identity: { readonly sessionId: string; readonly terminalId: string },
  operation: string,
): Promise<unknown> {
  if (operation === "kill") {
    expect(terminal.kill(identity)).toEqual({});
    return terminal.waitForExit(identity);
  }
  return operation === "release" ? terminal.release(identity) : terminal.dispose();
}

windowsTest.each(["timeout", "cancelled", "stdout", "stderr"])("a %s probe ends its launcher and descendants", async (mode) => {
  await withTreeProbe({ ignoreSigterm: false }, async (probe) => {
    const controller = new AbortController();
    const pending = runExecutable(fakeAgentBinary(probe.dir, [fixture]), [], {
      env: {
        ...process.env, ...probe.env,
        ...(mode === "stdout" || mode === "stderr" ? { OAR_FIXTURE_FLOOD: mode } : {}),
      },
      timeoutMs: mode === "timeout" ? 3000 : 60_000,
      signal: controller.signal,
    });
    const tree = await probe.tree();
    if (mode === "cancelled") { controller.abort(); }
    const result = await bounded(pending);
    expect(result, "the stopped probe settles while its descendants would otherwise hold its pipes").not.toBeNull();
    expect(result).toMatchObject({ ok: false, exitCode: null, diagnostics: mode === "timeout"
      ? { timeoutMs: 3000 }
      : { error: { code: mode === "cancelled" ? "ABORT_ERR" : "ERR_CHILD_PROCESS_STDIO_MAXBUFFER" } } });
    expect(await gone(tree.agent), `agent ${String(tree.agent)} exited`).toBe(true);
    expect(await gone(tree.grandchild), `descendant ${String(tree.grandchild)} exited`).toBe(true);
  });
});

windowsTest.each(["kill", "release", "dispose"])("ACP terminal %s ends the command's descendants", async (operation) => {
  await withTreeProbe({ ignoreSigterm: false }, async (probe) => {
    const terminal = createAcpTerminalHost(probe.dir, { ...process.env, ...probe.env });
    const created = await terminal.create({ sessionId: "tree", command: fakeAgentBinary(probe.dir, [fixture]), args: [] });
    const identity = { sessionId: "tree", terminalId: created.terminalId };
    const tree = await probe.tree();
    try {
      const stopped = stopTerminal(terminal, identity, operation);
      expect(await bounded(stopped.then(() => true)), "terminal shutdown settles with its output pipes closed").toBe(true);
      expect(await gone(tree.agent), `agent ${String(tree.agent)} exited`).toBe(true);
      expect(await gone(tree.grandchild), `descendant ${String(tree.grandchild)} exited`).toBe(true);
    } finally {
      // withTreeProbe reaps a failed test's tree before disposal waits for its pipes.
      void terminal.dispose();
    }
  });
});

windowsTest("stopping a login already ends the launcher and its descendants", async () => {
  await withTreeProbe({ ignoreSigterm: true }, async (probe) => {
    const child = spawnLoginProcess(fakeAgentBinary(probe.dir), [], { ...process.env, ...probe.env }, { onLine() {} });
    const tree = await probe.tree();
    child.stop();
    child.stop();
    expect(await bounded(child.exited)).not.toBeNull();
    expect(await gone(tree.agent)).toBe(true);
    expect(await gone(tree.grandchild)).toBe(true);
  });
});
