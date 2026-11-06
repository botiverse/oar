/* oxlint-disable typescript/no-unsafe-assignment, typescript/no-unsafe-member-access, typescript/no-unsafe-call, typescript/no-unsafe-argument -- Standalone untyped fixture preload. */
import assert from "node:assert/strict";
import fs from "node:fs";
import { syncBuiltinESMExports } from "node:module";

// Preload only in the interruption regression. Stop each fake CLI at a
// reproducible point inside its first state write, before it can publish it.
const [stateFile] = process.argv.slice(2);
const stage = process.env.OAR_LOGIN_WRITE_STAGE;
const write = fs.writeFileSync;
assert.ok(typeof stateFile === "string");
assert.ok(stage === "empty" || stage === "partial");
fs.writeFileSync = (file, data, options) => {
  if (typeof file !== "string" || !file.startsWith(stateFile)) {
    write(file, data, options);
    return;
  }
  assert.equal(typeof data, "string");
  write(file, stage === "empty" ? "" : data.slice(0, 4), options);
  fs.writeSync(1, "state-write-paused\n");
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0);
};
syncBuiltinESMExports();
