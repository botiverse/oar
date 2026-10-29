import { mkdirSync, writeFileSync } from "node:fs";
import path from "node:path";
import { expect, vi } from "vitest";
import type { openPiRpc, OpenPiRpc } from "../packages/oar/src/runtimes/pi/rpc/open.js";
import type { spawnLineProcess, LineProcess } from "../packages/oar/src/shared/executable/index.js";
import { sessionCredentialRedactor } from "../packages/oar/src/shared/credential-redactor.js";

// Test-only observation: native processes, inputs and adapter behavior stay real.
let nextProcess = 0;
const { context } = await vi.hoisted(async () => {
  const { AsyncLocalStorage } = await import("node:async_hooks");
  return { context: new AsyncLocalStorage<{ redact: (text: string) => string }>() };
});

vi.mock("../packages/oar/src/runtimes/pi/rpc/open.js", async (importOriginal) => {
  const actual = await importOriginal<{ openPiRpc: typeof openPiRpc }>();
  return { ...actual, openPiRpc: async (...args: Parameters<typeof actual.openPiRpc>): Promise<OpenPiRpc> => {
    const result = await context.run(args[1], actual.openPiRpc, ...args);
    return result;
  } };
});

vi.mock("../packages/oar/src/shared/executable/index.js", async (importOriginal) => {
  const actual = await importOriginal<{ spawnLineProcess: typeof spawnLineProcess }>();
  return { ...actual, spawnLineProcess: (...args: Parameters<typeof actual.spawnLineProcess>): LineProcess => {
    const child = actual.spawnLineProcess(...args);
    const directory = process.env.OAR_PI_RPC_DIAGNOSTICS;
    const credentials = context.getStore();
    if (directory === undefined || credentials === undefined || args[2]?.env?.OAR_PI_RPC_DIRECTORY === undefined) { return child; }
    const inherited = sessionCredentialRedactor({ env: Object.fromEntries(Object.entries(args[2].env ?? {}).flatMap(([name, value]) => value === undefined ? [] : [[name, value]])) });
    mkdirSync(directory, { recursive: true });
    const id = ++nextProcess;
    const file = path.join(directory, `stderr-${String(process.pid)}-${String(id)}.json`);
    const test = expect.getState().currentTestName;
    const save = (): void => {
      const facts = child.diagnostics();
      const stderr = inherited.redact(credentials.redact(facts.stderr));
      const record = { at: new Date().toISOString(), workerPid: process.pid, id, test, ...facts, stderr };
      writeFileSync(file, JSON.stringify(record), { mode: 0o600 });
    };
    save();
    const timer = setInterval(save, 500);
    timer.unref();
    child.onExit(() => { clearInterval(timer); save(); });
    return child;
  } };
});
