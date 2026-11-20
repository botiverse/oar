import assert from "node:assert/strict";
import { existsSync, writeFileSync } from "node:fs";
import path from "node:path";

// @ts-expect-error TS5097 -- Plain Node executes this fixture directly and needs its source extension.
import { captureProcess } from "./process-tree.ts";

const [directory] = process.argv.slice(2);
assert.ok(directory !== undefined);
writeFileSync(path.join(directory, "ready.json"), JSON.stringify(captureProcess(process.pid)));
const deadline = Date.now() + 60_000;
const timer = setInterval(() => {
  if (existsSync(path.join(directory, "stop")) || Date.now() >= deadline) { clearInterval(timer); }
}, 25);
