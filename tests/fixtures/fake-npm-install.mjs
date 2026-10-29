/* oxlint-disable typescript/no-unsafe-assignment, typescript/no-unsafe-member-access, typescript/no-unsafe-call, typescript/no-unsafe-argument -- Standalone untyped fixture executable. */
// An offline npm fixture: prefix lookup and one global CodeBuddy installation.
import assert from "node:assert/strict";
import { appendFileSync, mkdirSync, writeFileSync } from "node:fs";
import path from "node:path";

const prefix = process.env.npm_config_prefix;
const log = process.env.OAR_NPM_TEST_LOG;
assert.ok(typeof prefix === "string" && typeof log === "string");
const args = process.argv.slice(2);
appendFileSync(log, `${JSON.stringify(args)}\n`);
if (args[0] === "prefix" && args[1] === "-g") {
  if (process.env.OAR_NPM_TEST_FAIL === "1") {
    process.stderr.write("native failure with private details\n");
    process.exit(1);
  }
  process.stdout.write(`${prefix}\n`);
} else {
  assert.deepEqual(args, ["install", "-g", "@tencent-ai/codebuddy-code"]);
  const bin = process.platform === "win32" ? prefix : path.join(prefix, "bin");
  mkdirSync(bin, { recursive: true });
  const file = path.join(bin, process.platform === "win32" ? "codebuddy.cmd" : "codebuddy");
  writeFileSync(file, process.platform === "win32" ? "@echo CodeBuddy Code 0.0.0-fixture\r\n" : "#!/bin/sh\nprintf 'CodeBuddy Code 0.0.0-fixture\\n'\n", { mode: 0o755 });
  process.stdout.write("installed offline fixture\n");
}
