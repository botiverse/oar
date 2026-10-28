/* oxlint-disable eslint/max-statements, typescript/no-unsafe-assignment, typescript/no-unsafe-member-access, typescript/no-unsafe-call, typescript/no-unsafe-argument, typescript/no-unsafe-return, typescript/strict-boolean-expressions -- Standalone untyped fixture executable. */
import { readFileSync, writeFileSync } from "node:fs";
import { createInterface } from "node:readline";

const [stateFile, ...args] = process.argv.slice(2);
const state = JSON.parse(readFileSync(stateFile, "utf8"));
const save = () => writeFileSync(stateFile, JSON.stringify(state));
state.calls ??= [];
state.calls.push(args);
state.pids ??= [];
state.pids.push(process.pid);
state.environment = { home: process.env.KIMI_CODE_HOME, absent: process.env.OAR_KIMI_DELETE, marker: process.env.OAR_KIMI_MARKER };
state.environments ??= []; state.environments.push(state.environment);
save();
  const device = (code) => {
    process.stderr.write("Opening browser for Kimi device login: https://login.example.invalid/device\n");
    process.stderr.write(`If the browser did not open, paste the URL above and enter code: ${code}\n`);
  };
if (args[0] === "login") {
  [state.browserPath] = process.env.PATH.split(process.platform === "win32" ? ";" : ":"); save();
  if (state.mode === "existing") { process.stderr.write("Logged in to managed:kimi-code.\n"); process.exit(0); }
  if (state.mode === "failure") { process.stderr.write("Login failed: private-token private@example.invalid\n"); process.exit(1); }
  device("CODE-ONE");
  if (state.mode === "reissue") { device("CODE-TWO"); }
  if (state.mode === "wait") { setInterval(() => {}, 1000); }
  else {
    state.loggedIn = state.mode !== "false-success"; save();
    process.stderr.write("Logged in to managed:kimi-code.\n");
    process.exit(0);
  }
} else if (args[0] === "acp") {
  process.stderr.write("private-token private@example.invalid\n");
  createInterface({ input: process.stdin }).on("line", (line) => {
    const request = JSON.parse(line);
    state.methods ??= []; state.methods.push(request.method); save();
    const reply = (result) => process.stdout.write(`${JSON.stringify({ jsonrpc: "2.0", id: request.id, result })  }\n`);
    const fail = (code) => process.stdout.write(`${JSON.stringify({ jsonrpc: "2.0", id: request.id, error: { code, message: "private-token private@example.invalid" } })  }\n`);
    if (state.mode === "status-timeout") { return; }
    if (request.method === "initialize") {
      reply({ protocolVersion: 1, agentCapabilities: state.mode === "no-logout" ? {} : { auth: { logout: {} } }, authMethods: state.mode === "no-auth" ? [] : [{ id: "login", name: "Login" }] });
    } else if (request.method === "authenticate") {
      state.authParams = request.params; save();
      if (state.mode === "status-error") { fail(-32_603); }
      else if (state.loggedIn || process.env.OAR_KIMI_MARKER === "api-key") { reply({}); }
      else { fail(-32_000); }
    } else if (request.method === "logout") {
      if (state.mode === "logout-error") { fail(-32_603); }
      else { state.loggedIn = false; save(); reply({}); }
    } else { fail(-32_601); }
  });
} else { process.exit(2); }
