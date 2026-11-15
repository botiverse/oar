// oxlint-disable -- A stand-in executable, deliberately untyped like the protocol it fakes.
// droid 1.12.1's ACP sign-in entry, `droid exec --output-format acp`, as probed on 2026-11-15 (docs/runtimes/factory.md#login).
import { readFileSync } from "node:fs";
import { createInterface } from "node:readline";
import saveLoginState from "./login-state.mjs";

const [file, ...args] = process.argv.slice(2);
const state = JSON.parse(readFileSync(file, "utf8"));
const save = () => { saveLoginState(file, state); };
state.calls = [...state.calls ?? [], args];
save();
if (args.join(" ") !== "exec --output-format acp") { process.exit(2); }
const write = (message) => { process.stdout.write(`${JSON.stringify({ jsonrpc: "2.0", ...message })}\n`); };
const status = () => process.env.FACTORY_API_KEY
  ? { state: "authenticated", accounts: [{ label: "Factory API key", active: true }] }
  : (state.loggedIn ? { state: "authenticated", accounts: [{ label: "someone@example.com", active: true }] } : { state: "unauthenticated" });
let pendingAuth = null;
createInterface({ input: process.stdin }).on("line", (line) => {
  const message = JSON.parse(line);
  if (message.method === "initialize") {
    state.elicitation = message.params?.clientCapabilities?.elicitation ?? null; save();
    write({ id: message.id, result: { protocolVersion: 1, agentCapabilities: { auth: { logout: {}, status: {} } },
      authMethods: [{ id: "device-pairing", name: "Login" }, { id: "factory-api-key", name: "Factory API Key" }] } });
  } else if (message.method === "auth/status") {
    // A status that never answers, from a process that outlives SIGTERM: only the deadline ends the read.
    if (state.mode === "hang-status") { process.on("SIGTERM", () => {}); return; }
    write({ id: message.id, result: status() });
  } else if (message.method === "logout") {
    state.loggedIn = state.mode === "sticky"; save();
    write({ id: message.id, result: {} });
  } else if (message.method === "authenticate") {
    pendingAuth = message.id;
    if (state.mode === "hang") { return; }
    write({ id: 0, method: "elicitation/create", params: { mode: "url", requestId: message.id, elicitationId: "e1", message: "Sign in to Factory to continue this Droid thread.", url: "https://auth.factory.ai/device?user_code=ABCD-EFGH" } });
  } else if (message.id === 0 && pendingAuth !== null) {
    state.answer = message.result ?? message.error; save();
    write({ method: "elicitation/complete", params: { elicitationId: "e1" } });
    if (message.result?.action !== "accept") {
      write({ id: pendingAuth, error: { code: -32_000, message: "Authentication required: Sign-in was cancelled. Retry to sign in. " } });
    } else if (state.mode === "rejected") {
      write({ id: pendingAuth, error: { code: -32_000, message: "Device authentication failed: expired_token at https://auth.factory.ai/device?user_code=ABCD-EFGH" } });
    } else {
      state.loggedIn = state.mode !== "false-success"; save();
      write({ id: pendingAuth, result: {} });
    }
  }
});
