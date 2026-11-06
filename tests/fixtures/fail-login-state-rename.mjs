/* oxlint-disable typescript/no-unsafe-assignment, typescript/no-unsafe-member-access, typescript/no-unsafe-call, typescript/no-unsafe-argument -- Standalone controlled filesystem-failure preload. */
import assert from "node:assert/strict";
import fs from "node:fs";
import { syncBuiltinESMExports } from "node:module";

const [stateFile] = process.argv.slice(2);
const trace = process.env.OAR_RENAME_TRACE;
const platform = process.env.OAR_RENAME_PLATFORM;
assert.equal(typeof stateFile, "string");
assert.equal(typeof trace, "string");
assert.ok(platform === "win32" || platform === "linux");
// Exercise the Windows-only retry policy on every host; filesystem calls
// still use this machine's real paths and retain actual state snapshots.
Object.defineProperty(process, "platform", { value: platform });
const record = (event) => { fs.appendFileSync(trace, `${JSON.stringify(event)}\n`); };
const rename = fs.renameSync;
let failures = Number(process.env.OAR_RENAME_FAILURES);
assert.ok(Number.isInteger(failures) && failures > 0);
fs.renameSync = (from, to) => {
  if (to !== stateFile) { rename(from, to); return; }
  if (failures-- > 0) {
    record({ kind: "refused", state: JSON.parse(fs.readFileSync(stateFile, "utf8")) });
    throw Object.assign(new Error("controlled state rename refusal"), { code: process.env.OAR_RENAME_CODE });
  }
  rename(from, to);
  record({ kind: "renamed" });
};
const { wait } = Atomics;
Atomics.wait = (...args) => {
  const [array, index, value, timeout] = args;
  record({ kind: "wait", milliseconds: timeout });
  if (process.env.OAR_RENAME_PAUSE === "1") {
    fs.writeSync(1, "state-rename-retry-paused\n");
    return wait(array, index, value);
  }
  return wait(array, index, value, timeout);
};
syncBuiltinESMExports();
