/* oxlint-disable eslint/max-statements, typescript/no-unsafe-assignment, typescript/no-unsafe-member-access, typescript/no-unsafe-call, typescript/no-unsafe-argument, typescript/no-unsafe-return, typescript/strict-boolean-expressions -- Standalone untyped fixture executable. */
import { readFileSync, writeFileSync } from "node:fs";
import { createInterface } from "node:readline";

const [file] = process.argv.slice(2);
const state = JSON.parse(readFileSync(file, "utf8"));
if (process.argv.includes("--version") || process.argv.includes("--help")) {
  console.log(state.version ?? "2.178.1");
  process.exit(0);
}
const secret = "synthetic-private-codebuddy-access-token";
const save = () => writeFileSync(file, JSON.stringify(state));
const emit = (message) => process.stdout.write(`${JSON.stringify(message)}\n`);
const reply = (request_id, response) => emit({ type: "control_response", response: { subtype: "success", request_id, response } });
const emitAuth = (request) => emit({ type: "control_request", request_id: "native-auth-callback", request });
state.pids = [...state.pids ?? [], process.pid];
state.browser = process.env.BROWSER;
state.environment = process.env.CODEBUDDY_INTERNET_ENVIRONMENT;
save();
const input = createInterface({ input: process.stdin });
input.on("line", (line) => {
  const { request_id, request } = JSON.parse(line);
  state.requests = [...state.requests ?? [], request]; save();
  if (request.subtype === "initialize") {
    if (state.mode === "silent" || (state.mode === "silent-confirmation" && state.loggedIn)) { return; }
    reply(request_id, { account: state.loggedIn ? { token: secret, email: "private@example.invalid" } : null });
    return;
  }
  if (request.subtype !== "authenticate") { return; }
  emitAuth({ subtype: "auth_url_callback", authState: { state: "synthetic-state", authUrl: "https://www.codebuddy.ai/login?state=synthetic-state" } });
  if (state.mode === "cancel" || state.mode === "timeout") { return; }
  if (state.mode === "rejected") {
    emitAuth({ subtype: "auth_result_callback", success: false, userinfo: { token: secret } });
    emit({ type: "control_response", response: { subtype: "error", request_id, error: `Rejected token ${secret}` } });
    return;
  }
  state.loggedIn = state.mode !== "false-success"; save();
  emitAuth({ subtype: "auth_result_callback", success: true, userinfo: { token: secret } });
  reply(request_id, { success: true, userinfo: { token: secret } });
});
