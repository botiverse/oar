/* oxlint-disable typescript/no-unsafe-assignment, typescript/no-unsafe-member-access, typescript/no-unsafe-call, typescript/no-unsafe-argument -- Standalone untyped fixture executable. */
// A runtime CLI with an updater, for upgradeExecutable. The first argument is
// a JSON state file the test writes: { version, target, mode }. `--version`
// prints the version; `update` behaves as `mode` says, the ways real updaters
// do: "upgrade" installs target, "noop" claims success and changes nothing
// (codex when its download failed), "fail" exits non-zero, "prompt" waits for
// an answer on stdin before doing nothing (kimi without -y in a terminal).
import { readFileSync, writeFileSync } from "node:fs";

const [stateFile, command] = process.argv.slice(2);
const state = JSON.parse(readFileSync(stateFile, "utf8"));

function save(changes) {
  writeFileSync(stateFile, JSON.stringify({ ...state, ...changes }));
}

if (command === "--version") {
  process.stdout.write(`fake ${state.version} (fixture)\n`);
} else if (command === "update") {
  const seen = { updateArgs: process.argv.slice(4), sawUserAgent: process.env.npm_config_user_agent !== undefined };
  save(seen);
  if (state.mode === "upgrade") {
    save({ ...seen, version: state.target });
    process.stdout.write(`Updated to ${state.target}\n`);
  } else if (state.mode === "noop") {
    process.stdout.write("Update ran successfully!\n");
  } else if (state.mode === "fail") {
    process.stderr.write("error: failed to download update\n");
    process.exitCode = 3;
  } else {
    process.stdout.write("Install update now? [y/N] ");
    process.stdin.resume();
    process.stdin.on("end", () => {
      process.stdout.write("\nskipped\n");
    });
  }
}
