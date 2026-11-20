import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, test, vi } from "vitest";
import { databaseFiles, peersAt } from "../sea-trial/harness/opencode-database-context.js";
import { databaseErrorsInWindow, observeOpenCodeStartup } from "../sea-trial/harness/opencode-startup-log.js";

test("reports only native categories in the failed open's observation window", () => {
  const timestamp = "2026-11-20T06:06:38.135Z";
  const milliseconds = Date.parse(timestamp);
  const lines = [
    'timestamp=2026-11-20T06:06:35.000Z level=ERROR message="SQLITE_CANTOPEN"',
    `timestamp=${timestamp} level=INFO message="database schema bootstrap completed"`,
    `timestamp=${timestamp} level=ERROR message="cli process failed" cause="Failed to configure database: disk I/O error SQLITE_IOERR_SHMLOCK" args="fixture-private-text"`,
    `timestamp=${timestamp} level=ERROR message="SQLITE_PRIVATE_MARKER"`,
    'timestamp=2026-11-20T06:06:39.000Z level=ERROR message="SQLITE_BUSY"',
  ];
  expect(databaseErrorsInWindow(lines.join("\n"), milliseconds - 500, milliseconds)).toEqual([
    { timestamp, operations: ["configure database"], reasons: ["disk I/O error"], codes: ["SQLITE_IOERR_SHMLOCK"] },
  ]);
});


test("captures a native database failure even when the ACP exception omits stderr", async () => {
  const root = await mkdtemp(join(tmpdir(), "opencode-startup-log-"));
  const log = join(root, "opencode", "log");
  const original = new Error("ACP connection closed");
  const { record } = await import("../sea-trial/harness/trace.js");
  try {
    await mkdir(log, { recursive: true });
    const open = observeOpenCodeStartup(async () => {
      const timestamp = new Date().toISOString();
      await writeFile(join(log, "opencode.log"), `timestamp=${timestamp} level=ERROR cause="Failed to configure database: disk I/O error"`);
      throw original;
    }, root);
    await expect(open({ kind: "available", via: "bundled" }, { cwd: root })).rejects.toBe(original);
    expect(vi.mocked(record).mock.lastCall?.[0]).toMatchObject({
      status: "read", database: { path: join(root, "opencode", "opencode.db"), present: [] },
      peersAtRejection: { opening: 0, open: 0, closing: 0 },
      errors: [{ operations: ["configure database"], reasons: ["disk I/O error"], peers: { opening: 0, open: 0, closing: 0 } }],
    });
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

vi.mock("../sea-trial/harness/trace.js", () => ({ record: vi.fn() }));

test("the failure snapshot lists only SQLite files", async () => {
  const root = await mkdtemp(join(tmpdir(), "opencode-startup-files-"));
  try {
    const dir = join(root, "opencode");
    expect(databaseFiles(root).present).toEqual([]);
    await mkdir(dir);
    for (const name of ["opencode.db", "opencode.db-wal", "opencode.db-shm", "unrelated-private-name"]) {
      // oxlint-disable-next-line no-await-in-loop -- Construct the observed directory before sampling.
      await writeFile(join(dir, name), "");
    }
    expect(databaseFiles(root)).toMatchObject({ path: join(dir, "opencode.db"), present: ["opencode.db", "opencode.db-wal", "opencode.db-shm"] });
  } finally { await rm(root, { recursive: true, force: true }); }
});

test("a peer that exited before rejection still counts as closing at the time of the native error", () => {
  const peers = [{ start: 1, opened: 2, closing: 8, ended: 12 }, { start: 1, opened: 3 }, { start: 9 }, { start: 30 }];
  expect(peersAt(peers, 10)).toEqual({ open: 1, closing: 1, opening: 1 });
  expect(peersAt(peers, 12)).toEqual({ open: 1, closing: 0, opening: 1 });
});
