import { spawnSync } from "node:child_process";
import { expect, test } from "vitest";

// Exhaust only a separate host's descriptors, after it has loaded the implementation.
test.skipIf(process.platform === "win32")("EMFILE without a stdout pipe settles without leaving a crashing timer", () => {
  const source = `
    import fs from "node:fs";
    import { setTimeout as delay } from "node:timers/promises";
    import { processTableCommand, PROCESS_TABLE_TIMEOUT_MS } from ${JSON.stringify(new URL("../packages/oar/src/shared/executable/process-table-command.ts", import.meta.url).href)};
    import { processTableFailure } from ${JSON.stringify(new URL("../packages/oar/src/shared/executable/process-tree.ts", import.meta.url).href)};
    process.on("uncaughtException", error => { console.error(error); process.exit(98); });
    process.on("unhandledRejection", error => { console.error(error); process.exit(99); });
    const descriptors = [];
    try { while (true) { descriptors.push(fs.openSync("/dev/null", "r")); } }
    catch (error) { if (error.code !== "EMFILE") { throw error; } }
    const result = await processTableCommand(process.execPath, ["-e", "process.stdout.write('unexpected')"])
      .catch(error => processTableFailure(error, "ps", 0));
    for (const fd of descriptors) { fs.closeSync(fd); }
    await delay(PROCESS_TABLE_TIMEOUT_MS + 100);
    console.log(JSON.stringify(result));
  `;
  const host = spawnSync("bash", ["-c", 'ulimit -n 64\nexec "$@"', "oar-emfile", process.execPath, "--import", "tsx", "--input-type=module", "-e", source], {
    encoding: "utf8", timeout: 20_000,
  });
  expect(host.error, host.stderr).toBeUndefined();
  expect(host.status, host.stderr).toBe(0);
  expect(host.stderr).toBe("");
  expect(JSON.parse(host.stdout)).toMatchObject({ ok: false, code: "EMFILE", source: "ps" });
});
