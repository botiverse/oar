/* oxlint-disable eslint/max-statements, typescript/no-unsafe-assignment, typescript/no-unsafe-member-access, typescript/no-unsafe-call, typescript/no-unsafe-argument -- Standalone untyped fixture executable. */
// `claude auth login` and `claude auth status --json` as claude 2.1.288
// prints them, for the login driver. The first argument is a JSON state file:
// { version, code, email, loggedIn, mode }. `auth login` prints the URL as an
// OSC 8 hyperlink and the paste prompt with no newline, then reads stdin
// lines: a line without `#` is an invalid code (retryable), `code` signs in.
// Modes: "paste" (the default), "reject" (fails, echoing the pasted line, as
// a careless error message could), "browser" (the localhost callback signs
// in by itself), "unverified" (reports success without signing in), "hang"
// (starts a worker in its process group and never finishes).
import { spawn } from "node:child_process";
import { readFileSync, writeFileSync } from "node:fs";
import { createInterface } from "node:readline";

const [stateFile, ...args] = process.argv.slice(2);
const state = JSON.parse(readFileSync(stateFile, "utf8"));
const ESC = "\u001B";
const BEL = "\u0007";
const URL = "https://claude.com/cai/oauth/authorize?code=true&client_id=fixture&state=fixture-state";

function save(changes) {
  Object.assign(state, changes);
  writeFileSync(stateFile, JSON.stringify(state));
}

const command = args.join(" ");
if (command === "--version") {
  process.stdout.write(`${state.version} (Claude Code)\n`);
} else if (command === "auth status --json") {
  if (state.statusBroken === true) {
    process.stdout.write("not json\n");
    process.exitCode = 2;
  } else if (state.loggedIn === true) {
    process.stdout.write(`${JSON.stringify({ loggedIn: true, authMethod: "claude.ai", apiProvider: "firstParty", email: state.email, subscriptionType: "pro" }, null, 2)}\n`);
  } else {
    process.stdout.write(`${JSON.stringify({ loggedIn: false, authMethod: "none", apiProvider: "firstParty" }, null, 2)}\n`);
    process.exitCode = 1;
  }
} else if (command === "auth login") {
  save({ loginStarted: true, sawClaudeCode: process.env.CLAUDECODE !== undefined, received: [] });
  if (state.mode === "hang") {
    // Reported before any output, so a test that stops the login on its first prompt finds the worker.
    const worker = spawn(process.execPath, ["-e", "setInterval(() => {}, 1000)"], { stdio: "ignore" });
    save({ workerPid: worker.pid, pid: process.pid });
    setInterval(() => {}, 1000);
  }
  process.stdout.write(`${ESC}[2mOpening browser to sign in…${ESC}[22m\n`);
  process.stdout.write(`If the browser didn't open, visit: ${ESC}]8;;${URL}${BEL}${ESC}[4m${URL}${ESC}[24m${ESC}]8;;${BEL}\n`);
  process.stdout.write("Paste code here if prompted > ");
  if (state.mode === "browser") {
    setTimeout(() => {
      save({ loggedIn: true });
      process.stdout.write("Login successful.\n");
      process.exit(0);
    }, 200);
  }
  const lines = createInterface({ input: process.stdin });
  lines.on("line", (input) => {
    const line = String(input);
    save({ received: [...state.received, line] });
    if (state.mode === "reject") {
      process.stderr.write(`Login failed: invalid_grant for code ${line}\n`);
      process.exit(1);
    }
    if (!line.includes("#")) {
      process.stderr.write("Invalid code. Please make sure the full code was copied.\n");
      return;
    }
    if (line !== state.code) {
      process.stderr.write("Login failed: Request failed with status code 400\n");
      process.exit(1);
    }
    if (state.mode !== "unverified") {
      save({ loggedIn: true });
    }
    // No newline came before: claude's output continues the prompt's line.
    process.stdout.write("Login successful.\n");
    process.exit(0);
  });
} else {
  process.stderr.write(`unexpected arguments: ${command}\n`);
  process.exitCode = 64;
}
