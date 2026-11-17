/* oxlint-disable max-statements -- Exercise metadata changes in one isolated file tree. */
import { mkdtemp, mkdir, rm, symlink, utimes, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { expect, test } from "vitest";
import { compareInventory, inventory } from "../../experiments/antigravity-model-menus/file-inventory.js";
import { privateResponses } from "../../experiments/antigravity-model-menus/wire-filter.js";

test("inventory catches nested creation, removal, size and mtime changes without reading file contents", async () => {
  const directory = await mkdtemp(path.join(tmpdir(), "oar-menu-inventory-"));
  const roots = [{ label: "profile", path: directory }];
  const timestamp = new Date(1_700_000_000_000);
  try {
    await mkdir(path.join(directory, "state"));
    await Promise.all(["same", "mtime", "removed", "size"].map(async name => {
      await writeFile(path.join(directory, name), "PRIVATE_CONTENT");
      await utimes(path.join(directory, name), timestamp, timestamp);
    }));
    const before = await inventory(roots);
    await writeFile(path.join(directory, "state/person@example.invalid"), "PRIVATE_NEW_CONTENT");
    await rm(path.join(directory, "removed"));
    await writeFile(path.join(directory, "size"), "short");
    await utimes(path.join(directory, "mtime"), timestamp, new Date(timestamp.getTime() + 1000));
    const diff = compareInventory(before, await inventory(roots));
    expect(diff).toMatchObject({ complete: true, beforeFileCount: 4, afterFileCount: 4, changed: [
      { path: "profile/mtime", before: { mtimeMs: timestamp.getTime() }, after: { mtimeMs: timestamp.getTime() + 1000 } },
      { path: "profile/removed", after: null },
      { path: "profile/size", after: { size: 5 } },
      { path: "profile/state/[redacted-name]", before: null },
    ] });
    expect(JSON.stringify(diff)).not.toMatch(/PRIVATE|person@/u);
  } finally { await rm(directory, { recursive: true, force: true }); }
});

test("an inaccessible inventory root is explicitly incomplete", async () => {
  const directory = await mkdtemp(path.join(tmpdir(), "oar-menu-scan-error-"));
  try {
    const file = path.join(directory, "file");
    await writeFile(file, "private");
    const captured = await inventory([{ label: "profile", path: file }]);
    expect(compareInventory(captured, captured)).toMatchObject({ complete: false, beforeErrors: [{ path: "profile" }] });
  } finally { await rm(directory, { recursive: true, force: true }); }
});

test("wire filter excludes malformed and unsolicited frames and replaces native error text/data", () => {
  const filter = privateResponses();
  // @ts-expect-error Deliberately malformed native frame must never reach the SDK logger.
  expect(filter.incoming({ private: "PRIVATE_TOKEN" })).toBeUndefined();
  expect(filter.incoming({ jsonrpc: "2.0", method: "session/update", params: { private: "PRIVATE_TOKEN" } })).toBeUndefined();
  expect(filter.incoming({ jsonrpc: "2.0", id: "PRIVATE_ID", result: "PRIVATE_TOKEN" })).toBeUndefined();
  filter.outgoing({ jsonrpc: "2.0", id: 1, method: "session/new", params: {} });
  expect(filter.incoming({ jsonrpc: "2.0", id: 1, error: { code: -1, message: "PRIVATE_TOKEN", data: "PRIVATE_DATA" } })).toEqual({
    jsonrpc: "2.0", id: 1, error: { code: -1, message: "[native diagnostic redacted]" },
  });
  filter.outgoing({ jsonrpc: "2.0", id: 2, method: "session/new", params: {} });
  expect(filter.incoming({ jsonrpc: "2.0", id: 2, result: { model: "pro" } })).toEqual({ jsonrpc: "2.0", id: 2, result: { model: "pro" } });
  expect(filter.incoming({ jsonrpc: "2.0", id: 2, result: "duplicate" })).toBeUndefined();
});

test("nested symlink targets remain outside the scan and make completeness unknown", async () => {
  const directory = await mkdtemp(path.join(tmpdir(), "oar-menu-symlink-"));
  try {
    const root = path.join(directory, "profile");
    const outside = path.join(directory, "outside");
    await mkdir(root);
    await mkdir(outside);
    await writeFile(path.join(outside, "not-scanned"), "PRIVATE_CONTENT");
    await symlink(outside, path.join(root, "linked"), process.platform === "win32" ? "junction" : "dir");
    const captured = await inventory([{ label: "profile", path: root }]);
    expect([...captured.files.keys()]).toEqual(["profile/linked"]);
    expect(compareInventory(captured, captured)).toMatchObject({ complete: false, unscannedLinks: ["profile/linked"] });
  } finally { await rm(directory, { recursive: true, force: true }); }
});
