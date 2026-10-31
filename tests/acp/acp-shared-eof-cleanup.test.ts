import { readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { expect, test, vi } from "vitest";
import { asRecord } from "../../packages/oar/src/shared/json.js";
// oxlint-disable-next-line import/no-namespace -- Hold the real process-table read before native EOF to expose the last-lease boundary.
import * as tables from "../../packages/oar/src/shared/executable/process-table-async.js";
import { fixture } from "../fixtures/acp-shared-support.js";
import { gone } from "../fixtures/process-tree.js";

// Windows stops the tree with taskkill, so an EOF-only root exit is a POSIX control.
// oxlint-disable-next-line eslint/max-statements -- A real shared root must retain its independently grouped server and MCP identities across immediate EOF exit.
test.skipIf(process.platform === "win32")("last ACP lease captures before EOF and cleans server and MCP descendants when the root exits immediately", async () => {
  const f = await fixture({}, { args: [fileURLToPath(new URL("../fixtures/acp-eof-tree.mjs", import.meta.url))] });
  const report = path.join(f.cwd, "tree.json");
  const options = { env: { FIXTURE_TREE_REPORT: report } };
  const a = await f.open("a", options); const b = await f.open("b", options);
  const tree = asRecord(JSON.parse(await readFile(report, "utf8")));
  const root = Number(tree?.root); const server = Number(tree?.server);
  expect(Array.isArray(tree?.mcps)).toBe(true);
  const mcps = Array.isArray(tree?.mcps) ? tree.mcps.map(Number) : [];
  expect(mcps).toHaveLength(2);
  for (const pid of [root, server, ...mcps]) { expect(Number.isInteger(pid)).toBe(true); expect(() => process.kill(pid, 0)).not.toThrow(); }
  const entered = Promise.withResolvers<void>(); const release = Promise.withResolvers<void>();
  const original = tables.observeProcessTableAsync;
  const read = vi.spyOn(tables, "observeProcessTableAsync").mockImplementationOnce(async () => { entered.resolve(); await release.promise; return original(); });
  try {
    await a.dispose(); expect(read).not.toHaveBeenCalled();
    const disposal = b.dispose(); await entered.promise;
    expect(await readFile(`${report}.eof`, "utf8").catch(() => null)).toBeNull();
    for (const pid of [root, server, ...mcps]) { expect(() => process.kill(pid, 0)).not.toThrow(); }
    release.resolve(); await disposal;
    expect(await readFile(`${report}.eof`, "utf8")).toBe("EOF");
    expect(b.records().filter(record => record.kind === "response" && record.body.kind === "exited").map(record => record.body)).toEqual([{ kind: "exited", code: 0 }]);
    expect(await Promise.all([server, ...mcps].map(async pid => gone(pid)))).toEqual([true, true, true]);
  } finally {
    release.resolve(); read.mockRestore(); await b.dispose();
    for (const pid of [root, server, ...mcps]) { try { process.kill(pid, "SIGKILL"); } catch { /* Already exited. */ } }
  }
}, 30_000);
