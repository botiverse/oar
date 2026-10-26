/* oxlint-disable eslint/max-statements, typescript/no-unsafe-assignment, typescript/no-unsafe-member-access, typescript/no-unsafe-call, typescript/no-unsafe-argument, typescript/no-unsafe-return, typescript/strict-boolean-expressions -- Standalone untyped fixture executable. */
import { readFileSync, writeFileSync } from "node:fs";

const [file, ...args] = process.argv.slice(2);
const state = JSON.parse(readFileSync(file, "utf8"));
const save = () => writeFileSync(file, JSON.stringify(state));
// Capture only synthetic variables named by this test, never the inherited environment.
if (state.captureEnv !== undefined) {
  const environment = {};
  for (const name of state.captureEnv) {
    if (typeof name !== "string") { throw new TypeError("Expected a synthetic environment variable name"); }
    environment[name] = process.env[name] ?? null;
  }
  state.environments = [...state.environments ?? [], { args, environment }]; save();
}

state.calls = [...state.calls ?? [], args];
if (args[0] === "login") { state.loginBrowser = process.env.BROWSER; }
save();
if (args[0] === "--version") { console.log(state.version ?? "1.1.78"); process.exit(0); }
if (args[0] === "status") {
  if (state.mode === "status-error") { console.error("private-account-must-not-leak"); process.exit(1); }
  console.log(JSON.stringify({ logged_in: state.loggedIn, username: "private-user", email: "private@example.invalid", org_id: "private-org", access_token: "synthetic-private-token" }));
  process.exit(0);
}
if (args[0] !== "login") { process.exit(2); }
if (state.mode === "existing") { console.log("Already logged in as private-user."); process.exit(0); }
console.log("Starting browser login...");
console.log("  https://qoder.com/device/selectAccounts?challenge=synthetic-challenge\n");
if (state.mode === "cancel" || state.mode === "timeout") { setInterval(() => {}, 1000); }
else if (state.mode === "failure") { console.error("Login failed: synthetic-private-token"); process.exit(1); }
else {
  state.loggedIn = state.mode !== "false-success"; save();
  console.log("Login successful! Welcome, private-user.");
}
