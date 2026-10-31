import { build } from "esbuild";
import { execFile } from "node:child_process";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import { expect, test } from "vitest";

const executable = "packages/oar/src/shared/executable";

/** Replace the platform's query with a controlled real Node process, keeping
 * preparation, caller timer, command pipes/deadline and host ownership real. */
async function host(mode: "pending" | "query" | "foreground"): Promise<string> {
  const directory = await mkdtemp(path.join(tmpdir(), "oar-preparation-exit-"));
  try {
    const file = path.join(directory, "host.mjs");
    await build({ stdin: { contents: `
      import { prepareProcessTable, processTablePreparation } from './${executable}/process-table-preparation.ts';
      import { processTableCommand } from './${executable}/process-table-command.ts';
      let state = 'pending';
      if (process.argv[2] === 'foreground') {
        void processTableCommand(process.execPath, ['-e', "setTimeout(() => process.stdout.write('complete'), 200)"])
          .then(result => { state = result; });
      } else { prepareProcessTable(); }
      process.once('beforeExit', () => console.log(JSON.stringify(process.argv[2] === 'foreground' ? state : processTablePreparation())));
    `, resolveDir: process.cwd(), sourcefile: "preparation-host.ts" }, bundle: true, platform: "node", format: "esm", outfile: file,
    plugins: [{ name: "controlled-query", setup(builder) {
      // oxlint-disable-next-line require-unicode-regexp -- esbuild interprets this filter with Go's regexp engine.
      builder.onLoad({ filter: /process-table-async\.ts$/ }, () => ({ resolveDir: process.cwd(), loader: "ts", contents: `
        import { processTableCommand } from './${executable}/process-table-command.ts';
        export const processTableSource = () => 'windows';
        export async function observeProcessTableAsync(source, options) {
          if (process.argv[2] === 'pending') { return new Promise(() => {}); }
          await processTableCommand(process.execPath, ['-e', 'setTimeout(() => {}, 60000)'], undefined, options);
          return { ok: true, source, elapsedMs: 0, skipped: 0, table: new Map() };
        }
      ` }));
    } }] });
    // oxlint-disable-next-line typescript/strict-void-return -- Node returns a ChildProcess; promisify uses the completion callback.
    const result = await promisify(execFile)(process.execPath, [file, mode], { timeout: 20_000 });
    expect(result.stderr).toBe("");
    return result.stdout.trim();
  } finally { await rm(directory, { recursive: true, force: true }); }
}

test.each(["pending", "query"] as const)("background preparation does not keep an otherwise finished host alive: %s", async mode => {
  // Assert lifecycle, not a platform-sensitive elapsed-time threshold. If any
  // preparation handle stays referenced, beforeExit sees timeout metadata.
  expect(await host(mode)).toBe('{"status":"pending"}');
});

test("a foreground process-table query keeps the host alive through pipe drain", async () => {
  expect(await host("foreground")).toBe('"complete"');
});
