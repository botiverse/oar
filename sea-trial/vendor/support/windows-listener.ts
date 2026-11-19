import { createConnection } from "node:net";
import { execFile } from "node:child_process";
import { once } from "node:events";
import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import type { LineProcess } from "../../../packages/oar/src/shared/executable/index.js";

// oxlint-disable-next-line typescript/strict-void-return -- execFile supplies a promise overload through promisify.
const run = promisify(execFile);
const windows = { windowsHide: true, timeout: 10_000, maxBuffer: 1024 * 1024 };
const processScript = fileURLToPath(new URL("windows-listener.ps1", import.meta.url));

async function processIdentities(ids: readonly number[]): Promise<unknown> {
  try {
    const result = await run("powershell.exe", ["-NoProfile", "-NonInteractive", "-ExecutionPolicy", "RemoteSigned",
      "-File", processScript, "-ProcessIds", ids.join(",")], windows);
    const rows: unknown = JSON.parse(result.stdout);
    return rows;
  } catch (error) { return { failed: error instanceof Error ? error.name : "unknown" }; }
}

/** Capture the specific loopback listener before querying CIM: its owner can exit while CIM starts. */
async function sample(port: number, root: number, stage: string, connection?: Connection): Promise<object> {
  const started = Date.now();
  try {
    const { stdout } = await run("netstat.exe", ["-ano", "-p", "TCP"], windows);
    const observed = Date.now();
    const owners = stdout.split(/\r?\n/u).flatMap(line => {
      const [protocol, local, peer, , pid] = line.trim().split(/\s+/u);
      return protocol === "TCP" && (local === `127.0.0.1:${port}` || local === `0.0.0.0:${port}`)
        && peer === "0.0.0.0:0" && pid !== undefined && /^\d+$/u.test(pid) ? [Number(pid)] : [];
    });
    const ids = [...new Set([root, ...owners])];
    const processes = await processIdentities(ids);
    return { stage, connection, started, observed, owners, processes };
  } catch (error) {
    return { stage, connection, started, failed: error instanceof Error ? error.name : "unknown" };
  }
}

type Connection = { connected: false } | { connected: true; localPort: number | undefined; remotePort: number | undefined };

/** A real TCP connect, independent of process exit or an OS listener-table observation. */
export async function probePort(port: number): Promise<Connection> {
  const socket = createConnection({ host: "127.0.0.1", port });
  try {
    await once(socket, "connect");
    return { connected: true, localPort: socket.localPort, remotePort: socket.remotePort };
  } catch { return { connected: false }; }
  finally { socket.destroy(); }
}

export function windowsListenerTrace(port: number, child: LineProcess): {
  mark(stage: string, connection?: Connection): void;
  finish(): Promise<void>;
} {
  const snapshots: Promise<object>[] = [];
  const mark = (stage: string, connection?: Connection): void => {
    if (child.pid !== undefined) { snapshots.push(sample(port, child.pid, stage, connection)); }
  };
  mark("listening");
  return {
    mark,
    async finish() {
      mark("cleanup-finished");
      const [snapshotsAtStages, openAfterCleanup] = await Promise.all([Promise.all(snapshots), probePort(port)]);
      const evidence = { port, root: child.pid, openAfterCleanup, cleanup: child.diagnostics().cleanup, snapshots: snapshotsAtStages };
      const directory = path.resolve(process.env.OAR_TRIAL_RUN_DIR ?? "oar-trial-run", "opencode-cleanup");
      await mkdir(directory, { recursive: true });
      await writeFile(path.join(directory, "skills-listener.json"), JSON.stringify(evidence, null, 2));
    },
  };
}
