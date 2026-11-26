import { execFileSync } from "node:child_process";
import fs from "node:fs";

type ProcessRow = readonly [pid: number, ppid: number, start: string];

function readLinuxProcessTable(): ProcessRow[] {
  const rows: ProcessRow[] = [];
  for (const name of fs.readdirSync("/proc")) {
    if (!/^\d+$/u.test(name)) { continue; }
    try {
      const stat = fs.readFileSync(`/proc/${name}/stat`, "utf8");
      const fields = stat.slice(stat.lastIndexOf(")") + 2).split(" ");
      rows.push([Number(name), Number(fields[1]), fields[19] ?? ""]);
    } catch { /* Process exited between readdir and read. */ }
  }
  return rows;
}

function readPosixProcessTable(): ProcessRow[] {
  if (process.platform === "linux") { return readLinuxProcessTable(); }
  const output = execFileSync("/bin/ps", ["-A", "-o", "pid=,ppid=,lstart="], {
    encoding: "utf8",
    timeout: 10_000,
    windowsHide: true,
  });
  return output.split("\n")
    .map((line) => line.trim().split(/\s+/u))
    .filter((cells) => cells.length > 2)
    .map((cells) => [Number(cells[0]), Number(cells[1]), cells.slice(2).join(" ")] as const);
}

function findDescendants(rows: readonly ProcessRow[]): Map<number, string> {
  const below = new Map<number, ProcessRow[]>();
  for (const row of rows) {
    const existing = below.get(row[1]);
    if (existing === undefined) { below.set(row[1], [row]); }
    else { existing.push(row); }
  }
  const found = new Map<number, string>();
  const pending = [process.pid];
  while (pending.length > 0) {
    const parent = pending.pop();
    if (parent === undefined) { continue; }
    for (const row of below.get(parent) ?? []) {
      if (!found.has(row[0])) {
        found.set(row[0], row[2]);
        pending.push(row[0]);
      }
    }
  }
  return found;
}

function killLinuxMarkedProcesses(marker: string): void {
  if (process.platform !== "linux" || process.getuid === undefined) { return; }
  const uid = process.getuid();
  for (let pass = 0; pass < 5; pass += 1) {
    let found = 0;
    for (const name of fs.readdirSync("/proc")) {
      try {
        if (!/^\d+$/u.test(name) || Number(name) === process.pid || fs.statSync(`/proc/${name}`).uid !== uid) { continue; }
        if (fs.readFileSync(`/proc/${name}/environ`, "latin1").split("\0").includes(marker)) {
          process.kill(Number(name), "SIGKILL");
          found += 1;
        }
      } catch { /* Process exited or unreadable. */ }
    }
    if (found === 0) { break; }
  }
}

function isParentGone(initialParentPid: number): boolean {
  if (process.ppid !== initialParentPid) { return true; }
  if (process.platform !== "win32") { return false; }
  try {
    process.kill(initialParentPid, 0);
    return false;
  } catch (error) {
    return typeof error === "object" && error !== null && Reflect.get(error, "code") === "ESRCH";
  }
}

function killPosixDescendants(seen: ReadonlyMap<number, string>): void {
  try {
    const rows = readPosixProcessTable();
    const current = new Map(rows.map((row) => [row[0], row[2]]));
    const targets = new Map<number, string>();
    for (const [pid, start] of seen) {
      if (current.get(pid) === start) { targets.set(pid, start); }
    }
    for (const [pid, start] of findDescendants(rows)) { targets.set(pid, start); }
    for (const pid of targets.keys()) {
      try { process.kill(pid, "SIGKILL"); } catch { /* Already exited. */ }
    }
  } catch { /* Best-effort exit cleanup. */ }
}

export interface ChildGuardOptions {
  readonly graceMs: number;
  readonly taskkill: string | null;
  readonly marker: string;
  readonly closeAll: () => Promise<unknown>[];
}

/**
 * Installs signal, disconnect, parent-death, uncaughtException, and exit hooks
 * matching the inline cursor child script so a host-launched child cleans up
 * open SDK handles and descendant processes the same way.
 */
export function installIpcChildGuards(options: ChildGuardOptions): { readonly shutdown: (code: number) => Promise<void> } {
  const windows = process.platform === "win32";
  let stopping = false;
  let orphaned = false;
  let asked = false;
  let seen = new Map<number, string>();

  const remember = (): void => {
    if (windows) { return; }
    try { seen = findDescendants(readPosixProcessTable()); } catch { /* Best-effort snapshot. */ }
  };

  process.on("exit", () => {
    if (windows) {
      if (!asked && options.taskkill !== null) {
        try { execFileSync(options.taskkill, ["/pid", String(process.pid), "/T", "/F"], { stdio: "ignore", windowsHide: true, timeout: 10_000 }); } catch { /* Best-effort kill. */ }
      }
      return;
    }
    killPosixDescendants(seen);
    killLinuxMarkedProcesses(options.marker);
    if (orphaned) {
      try { process.kill(-process.pid, "SIGKILL"); } catch { /* Group already gone. */ }
    }
  });

  const shutdown = async (code: number): Promise<void> => {
    if (stopping) { return; }
    stopping = true;
    asked = code === 0;
    remember();
    const pending = options.closeAll();
    await Promise.race([Promise.allSettled(pending), new Promise((resolve) => { setTimeout(resolve, options.graceMs); })]);
    process.exit(code);
  };

  process.on("SIGTERM", () => { void shutdown(0); });
  process.on("uncaughtException", (error) => {
    const text = error instanceof Error && typeof error.stack === "string" && error.stack !== "" ? error.stack : String(error);
    try { fs.writeSync(2, `${text}\n`); } catch { /* Ignore stderr write failure. */ }
    process.exit(1);
  });
  process.on("disconnect", () => { orphaned = true; void shutdown(1); });
  const initialParentPid = process.ppid;
  setInterval(() => {
    if (isParentGone(initialParentPid)) {
      orphaned = true;
      void shutdown(1);
    }
  }, 1000).unref();

  return { shutdown };
}
