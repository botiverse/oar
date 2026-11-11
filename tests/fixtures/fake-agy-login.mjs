/* oxlint-disable eslint/max-statements, typescript/no-unsafe-assignment, typescript/no-unsafe-member-access, typescript/no-unsafe-call, typescript/no-unsafe-return, typescript/no-unsafe-argument, typescript/strict-boolean-expressions -- Standalone untyped fixture executable. */
// agy 1.5.5's login and model listing as observed on 2026-11-10 (docs/runtimes/antigravity.md#login).
import { existsSync, readFileSync } from "node:fs";
import path from "node:path";
import { createInterface } from "node:readline";
import saveLoginState from "./login-state.mjs";

const [file, ...args] = process.argv.slice(2);
const state = JSON.parse(readFileSync(file, "utf8"));
const save = () => { saveLoginState(file, state); };
state.calls = [...state.calls ?? [], args];
if (args[0] === "acp") {
  // agy starts this launcher itself, found on PATH; resolved here, never run.
  const launchers = { win32: "rundll32.exe", darwin: "open" };
  const launcher = launchers[process.platform] ?? "xdg-open";
  const found = (process.env.PATH ?? "").split(path.delimiter).map((dir) => path.join(dir, launcher)).find((candidate) => existsSync(candidate));
  state.launcher = found ?? null;
}
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
    // Live 1.5.5: an empty line is not an answer; agy keeps waiting.
    if (line.trim() === "") { state.emptyLines = (state.emptyLines ?? 0) + 1; save(); answered = false; return; }
    if (state.mode === "rejected") {
      // agy names the code it tried, also when the person pasted the whole landing URL.
      const code = URL.canParse(line.trim()) ? new URL(line.trim()).searchParams.get("code") : line.trim();
      console.log(`login failed: invalid_grant ${code}`); process.exit(1);
    }
    state.loggedIn = state.mode !== "false-success"; save();
    process.exit(0);
  });
  lines.on("close", () => { if (!answered) { console.log("login cancelled: no authorization code was entered"); process.exit(1); } });
}
