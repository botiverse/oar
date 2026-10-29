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
const account = { token: secret, email: "private@example.invalid", uid: "private-uid", userId: "private-user-id", nickname: "private-nickname", enterpriseName: "private-enterprise", enterpriseId: "private-enterprise-id" };
const save = () => writeFileSync(file, JSON.stringify(state));
const emit = (message) => process.stdout.write(`${JSON.stringify(message)}\n`);
const reply = (request_id, response) => emit({ type: "control_response", response: { subtype: "success", request_id, response } });
const fail = (request_id, error) => emit({ type: "control_response", response: { subtype: "error", request_id, error } });
const emitAuth = (request) => emit({ type: "control_request", request_id: "native-auth-callback", request });
state.pids = [...state.pids ?? [], process.pid];
state.browser = process.env.BROWSER;
state.browsers = [...state.browsers ?? [], process.env.BROWSER ?? null];
state.environment = process.env.CODEBUDDY_INTERNET_ENVIRONMENT;
save();
const input = createInterface({ input: process.stdin });
input.on("line", (line) => {
  const { request_id, request } = JSON.parse(line);
  state.requests = [...state.requests ?? [], request]; save();
  if (request.subtype === "initialize") {
    if (state.mode === "silent" || (state.mode === "silent-confirmation" && state.loggedIn)) { return; }
    if (state.mode === "initialize-error") { fail(request_id, "initialize is unavailable"); return; }
    reply(request_id, { account: state.loggedIn ? account : null });
    return;
  }
  if (request.subtype !== "authenticate") { return; }
  if (state.mode === "authenticate-error") { fail(request_id, "Unknown control request: authenticate"); return; }
  emitAuth({ subtype: "auth_url_callback", authState: { state: "synthetic-state", authUrl: "https://www.codebuddy.ai/login?state=synthetic-state" } });
  if (state.mode === "cancel" || state.mode === "timeout") { return; }
  if (state.mode === "rejected") {
    emitAuth({ subtype: "auth_result_callback", success: false, userinfo: account });
    fail(request_id, `Rejected token ${secret}`);
    return;
  }
  if (state.mode === "identity-error") { fail(request_id, `Account query failed: ${Object.values(account).join(" ")}`); return; }
  if (["auth_failed", "native-timeout", "native-cancelled"].includes(state.mode)) {
    const type = { "native-timeout": "timeout", "native-cancelled": "cancelled", auth_failed: "auth_failed" }[state.mode];
    const error = { type, message: `Authentication ${type}: ${secret}` };
    emitAuth({ subtype: "auth_result_callback", success: false, userinfo: account, error });
    fail(request_id, error.message);
    return;
  }
  state.loggedIn = state.mode !== "false-success"; save();
  emitAuth({ subtype: "auth_result_callback", success: true, userinfo: { token: secret } });
  reply(request_id, { success: true, userinfo: { token: secret } });
});
