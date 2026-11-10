/* oxlint-disable eslint/max-statements, typescript/no-unsafe-assignment, typescript/no-unsafe-member-access, typescript/no-unsafe-call, typescript/no-unsafe-argument, typescript/strict-boolean-expressions -- Standalone untyped fixture executable. */
// agy 1.5.5's login and model listing as observed on 2026-11-10 (docs/runtimes/antigravity.md#login).
import { readFileSync } from "node:fs";
import { createInterface } from "node:readline";
import saveLoginState from "./login-state.mjs";

const [file, ...args] = process.argv.slice(2);
const state = JSON.parse(readFileSync(file, "utf8"));
const save = () => { saveLoginState(file, state); };
state.calls = [...state.calls ?? [], args];
if (args[0] === "acp") { state.loginBrowser = process.env.BROWSER ?? null; }
save();
if (args[0] === "models") {
  if (state.mode === "models-error") { console.error("Error: failed to reach the model service"); process.exit(1); }
  if (!state.loggedIn) { console.log("Fetching available models..."); console.log("Error: Please sign in to view available models. Launch the CLI without arguments to sign in."); process.exit(1); }
  console.log("Fetching available models...\nGemini 3.5 Pro\nGemini 3.5 Flash");
  process.exit(0);
}
if (args[0] !== "acp" || args[1] !== "--login") { process.exit(2); }
console.log("Open this link in a browser to log in with Google:\n");
console.log("  https://accounts.google.com/o/oauth2/auth?client_id=synthetic&code_challenge=synthetic&state=synthetic\n");
process.stdout.write("Then paste the authorization code, or the full URL of the page you land on, and press Enter:\n");
if (state.mode === "hang") { setInterval(() => {}, 1000); }
else {
  const lines = createInterface({ input: process.stdin });
  let answered = false;
  lines.on("line", (line) => {
    answered = true;
    state.pasted = line; save();
    if (line.trim() === "") { console.log("login cancelled: no authorization code was entered"); process.exit(1); }
    if (state.mode === "rejected") { console.log("login failed: invalid_grant synthetic-private-code"); process.exit(1); }
    state.loggedIn = state.mode !== "false-success"; save();
    process.exit(0);
  });
  lines.on("close", () => { if (!answered) { console.log("login cancelled: no authorization code was entered"); process.exit(1); } });
}
