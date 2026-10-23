import assert from "node:assert/strict";
import { test } from "vitest";
import { spawnLineProcess } from "../packages/oar/src/shared/executable/index.js";

// oxlint-disable-next-line eslint/max-statements -- Keep the real child's private exchange and stdout evidence in one scenario.
test("an extra pipe exchanges private data without writing it to stdout", async () => {
  const child = spawnLineProcess(process.execPath, ["-e", String.raw`
    const { Socket } = require("node:net");
    const pipe = new Socket({ fd: 3, readable: true, writable: true });
    pipe.on("data", (chunk) => {
      if (chunk.toString() !== "received") process.exitCode = 2;
      process.stdout.write("acknowledged\n");
      pipe.end();
    });
    pipe.write("private-key");
  `], { extraPipe: true });
  const lines: string[] = [];
  child.onLine((line) => { lines.push(line); });
  try {
    assert.ok(child.extraPipe);
    let received = "";
    child.extraPipe.on("data", (chunk: Buffer) => {
      received += chunk.toString();
      if (received === "private-key") { child.extraPipe?.write("received"); }
    });
    assert.equal(await child.exited, 0);
    assert.equal(received, "private-key");
    assert.deepEqual(lines, ["acknowledged"]);
  } finally { child.kill(); await child.exited; }
});

