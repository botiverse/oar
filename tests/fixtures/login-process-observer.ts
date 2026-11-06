import { vi } from "vitest";
import type { AcpProcess } from "../../packages/oar/src/shared/acp/process.js";
import type { LoginProcessExit, LoginStream } from "../../packages/oar/src/shared/login.js";

type Snapshots = (() => unknown)[];

async function observeLogin(command: string, snapshots: Snapshots): Promise<void> {
  const login = await import("../../packages/oar/src/shared/login.js");
  const spawn = login.spawnLoginProcess;
  // oxlint-disable-next-line eslint/max-statements -- Preserve the real launch, output handlers and exit while observing one fake process.
  vi.spyOn(login, "spawnLoginProcess").mockImplementation((...parameters) => {
    const [actual, args, env, handlers] = parameters;
    if (actual !== command) { return spawn(...parameters); }
    const entry: { kind: string; args: readonly string[]; lines: { stream: LoginStream; text: string }[]; exit?: LoginProcessExit; error?: string } = { kind: "login", args, lines: [] };
    snapshots.push(() => entry);
    try {
      const child = spawn(actual, args, env, {
        ...handlers,
        onLine(text, stream) { entry.lines.push({ stream, text }); handlers.onLine(text, stream); },
      });
      void (async () => { entry.exit = await child.exited; })();
      return child;
    } catch (error) { entry.error = String(error); throw error; }
  });
}

async function observeAcp(command: string, snapshots: Snapshots): Promise<void> {
  const acp = await import("../../packages/oar/src/shared/acp/process.js");
  const start = acp.startAcpProcess;
  vi.spyOn(acp, "startAcpProcess").mockImplementation((...parameters) => {
    if (parameters[0] !== command) { return start(...parameters); }
    const entry: { child?: AcpProcess; error?: string } = {};
    snapshots.push(() => ({ kind: "acp", args: parameters[1], diagnostics: entry.child?.diagnostics(), error: entry.error }));
    try { entry.child = start(...parameters); return entry.child; }
    catch (error) { entry.error = String(error); throw error; }
  });
}

/** Observe only the supplied fake CLI; real authentication output stays private. */
export default async function observeFakeLogin(command: string): Promise<() => readonly unknown[]> {
  const snapshots: Snapshots = [];
  await observeLogin(command, snapshots);
  await observeAcp(command, snapshots);
  return () => snapshots.map((snapshot) => snapshot());
}
