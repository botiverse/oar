/* oxlint-disable eslint/max-statements, typescript/no-unsafe-assignment, typescript/no-unsafe-member-access, typescript/no-unsafe-call, typescript/no-unsafe-return, typescript/no-unsafe-argument, typescript/strict-boolean-expressions -- Standalone untyped fixture executable. */
// grok 1.0.77's login, model listing and logout as observed on 2026-11-11 (docs/runtimes/grok.md#login).
import { readFileSync } from "node:fs";
import saveLoginState from "./login-state.mjs";

const [file, ...args] = process.argv.slice(2);
const state = JSON.parse(readFileSync(file, "utf8"));
const save = () => { saveLoginState(file, state); };
state.calls = [...state.calls ?? [], args];
save();
if (args[0] === "models") {
  if (state.mode === "models-error") { console.error("Error: failed to reach the model service"); process.exit(1); }
  if (!state.loggedIn) { console.log("You are not authenticated.\n\nDefault model: grok-4.6\n\nAvailable models:\n  * grok-4.6 (default)"); process.exit(0); }
  if (state.mode === "silent-models") { console.log("Default model: grok-4.6"); process.exit(0); }
  console.log("You are logged in with grok.com.\n\nDefault model: grok-4.6\n\nAvailable models:\n  * grok-4.6 (default)\n  * grok-code");
  process.exit(0);
}
if (args[0] === "logout") {
  if (!state.loggedIn) { console.log("No cached session to log out of."); process.exit(0); }
  state.loggedIn = state.mode === "sticky"; save();
  console.log("Logged out.");
  process.exit(0);
}
if (args[0] !== "login" || args[1] !== "--device-auth") { process.exit(2); }
// Grok starts a browser itself: BROWSER when set, else the desktop launcher.
state.browser = process.env.BROWSER ?? null; save();
console.log("\nTo sign in, open this URL in your browser:\n");
console.log("  https://accounts.x.ai/oauth2/device?user_code=WXYZ-1234\n");
console.log("Confirm this code in your browser:\n");
console.log("  WXYZ-1234\n");
console.log("Waiting for authorization...");
if (state.mode === "hang") { setInterval(() => {}, 1000); }
else {
  setTimeout(() => {
    if (state.mode === "rejected") { console.error("Error: the device code expired"); process.exit(1); }
    state.loggedIn = state.mode !== "false-success"; save();
    console.log("Signed in.");
    process.exit(0);
  }, 50);
}
