import { open } from "node:fs/promises";
import { join } from "node:path";
import type { StartSession } from "../../packages/oar/src/contracts/session.js";
import { databaseFiles, observeLifetime, peersAt, type OpenLifetime } from "./opencode-database-context.js";
import { record } from "./trace.js";

const reasons = [
  "disk I/O error", "locking protocol", "database is locked", "database table is locked",
  "unable to open database file", "file is not a database", "database disk image is malformed",
  "access is denied", "sharing violation",
];
const operations = ["open database", "configure database", "database schema bootstrap", "migrate database", "prepare statement", "execute statement", "wal_checkpoint", "journal_mode"];
// Only known SQLite result names leave the fixture. Messages, paths, SQL and arguments stay private.
const codes = new Set([
  "SQLITE_IOERR", "SQLITE_BUSY", "SQLITE_LOCKED", "SQLITE_CANTOPEN", "SQLITE_PROTOCOL", "SQLITE_CORRUPT", "SQLITE_NOTADB",
  "SQLITE_BUSY_RECOVERY", "SQLITE_BUSY_SNAPSHOT", "SQLITE_BUSY_TIMEOUT", "SQLITE_LOCKED_SHAREDCACHE",
  ...["READ", "SHORT_READ", "WRITE", "FSYNC", "TRUNCATE", "FSTAT", "UNLOCK", "RDLOCK", "DELETE", "ACCESS", "CHECKRESERVEDLOCK",
    "LOCK", "CLOSE", "SHMOPEN", "SHMSIZE", "SHMLOCK", "SHMMAP", "SEEK", "MMAP", "GETTEMPPATH"].map(suffix => `SQLITE_IOERR_${suffix}`),
]);

interface NativeDatabaseError {
  readonly timestamp: string;
  readonly operations: readonly string[];
  readonly reasons: readonly string[];
  readonly codes: readonly string[];
}

/** OpenCode's log is shared by native processes. These are observations in the open's time window. */
export function databaseErrorsInWindow(text: string, start: number, end: number): NativeDatabaseError[] {
  const errors: NativeDatabaseError[] = [];
  for (const line of text.split("\n")) {
    const at = /^timestamp=(\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z) level=ERROR\b/u.exec(line)?.[1];
    if (at === undefined) { continue; }
    const ms = Date.parse(at);
    if (!(ms >= start && ms <= end)) { continue; }
    const lower = line.toLowerCase();
    const reason = reasons.filter(value => lower.includes(value.toLowerCase()));
    const operation = operations.filter(value => lower.includes(value));
    const sqlite = [...new Set(line.match(/\bSQLITE_[A-Z0-9_]+\b/gu))].filter(value => codes.has(value));
    if (reason.length > 0 || operation.length > 0 || sqlite.length > 0) {
      errors.push({ timestamp: at, operations: operation, reasons: reason, codes: sqlite });
    }
  }
  return errors;
}

/** Read only the bounded tail of the native fixture log before the fixture is removed. */
export async function readStartupErrors(dataRoot: string, start: number, end: number): Promise<NativeDatabaseError[]> {
  const file = await open(join(dataRoot, "opencode", "log", "opencode.log"), "r");
  try {
    const { size } = await file.stat();
    const length = Math.min(size, 128 * 1024);
    const buffer = Buffer.alloc(length);
    const { bytesRead } = await file.read(buffer, 0, length, size - length);
    return databaseErrorsInWindow(buffer.toString("utf8", 0, bytesRead), start, end);
  } finally { await file.close(); }
}

/** A native exit can reach OAR before its stderr. Inspect rejected opens even when the wrapper omitted its readiness message. */
export function observeOpenCodeStartup(openSession: StartSession, dataRoot: string): StartSession {
  const lifetimes: OpenLifetime[] = [];
  return async (installation, options, context) => {
    const start = Date.now();
    const lifetime: OpenLifetime = { start };
    lifetimes.push(lifetime);
    try {
      const session = await openSession(installation, options, context);
      try { observeLifetime(lifetime, session); } catch { /* Diagnostic registration must preserve a successful open. */ }
      return session;
    } catch (error) {
      const end = Date.now();
      lifetime.ended = end;
      try {
        const database = databaseFiles(dataRoot);
        const peers = lifetimes.filter(peer => peer !== lifetime);
        const errors = await readStartupErrors(dataRoot, start, end).catch(() => null);
        const readiness = error instanceof Error && error.message.includes("Standalone server exited before reporting readiness");
        if (readiness || (errors !== null && errors.length > 0)) {
          record({ kind: "opencode_startup_database", start, end, status: errors === null ? "unavailable" : "read", database,
            peersAtRejection: peersAt(peers, end), errors: errors?.map(({ timestamp, operations: ops, reasons: why, codes: sqlite }) => ({ timestamp, operations: ops, reasons: why, codes: sqlite, peers: peersAt(peers, Date.parse(timestamp)) })) ?? null });
        }
      } catch { /* A trace write failure must preserve the original open error. */ }
      throw error;
    }
  };
}
