/* oxlint-disable eslint/max-statements, eslint/max-lines-per-function, eslint/complexity, typescript/no-unsafe-assignment, typescript/no-unsafe-member-access, typescript/no-unsafe-call, typescript/no-unsafe-return, typescript/no-unsafe-argument, typescript/strict-boolean-expressions -- Standalone untyped fixture executable. */
// `opencode serve` 2.2.7's integration and credential API as observed on
// 2026-11-11 (docs/runtimes/opencode.md#provider-authentication): the
// listening line, basic auth, a registry that fills after startup, key and
// OAuth connects, attempt status, complete, cancel and credential.remove.
import { createServer } from "node:http";
import { readFileSync } from "node:fs";
import saveLoginState from "./login-state.mjs";

const [file, ...args] = process.argv.slice(2);
const state = JSON.parse(readFileSync(file, "utf8"));
const save = () => { saveLoginState(file, state); };
state.argv = args;
state.cwd = process.cwd();
state.calls = [];
state.cancelled = [];
state.serverPid = process.pid;
save();
if (args[0] === "--version") { console.log("opencode v2.2.7"); process.exit(0); }
if (args[0] !== "serve") { process.exit(2); }
if (state.startup === "crash") { console.error("Error: database is locked"); process.exit(1); }

const password = process.env.OPENCODE_PASSWORD;
let unready = state.unreadyReads ?? 2;
let next = 1;
const attempts = new Map();

const send = (res, status, body) => {
  res.writeHead(status, body === undefined ? {} : { "content-type": "application/json" });
  res.end(body === undefined ? "" : JSON.stringify(body));
};
const invalid = (res, message) => { send(res, 400, { _tag: "InvalidRequestError", message, kind: "integration_authorization" }); };
const find = (id) => state.integrations.find((entry) => entry.id === id);
const missingField = (form, answer) => (form ?? []).find((field) => field.required && !field.hidden
  && (field.when ?? []).every((when) => (when.op === "neq") !== (answer?.[when.key] === when.value))
  && (answer?.[field.key] === undefined || answer[field.key] === ""));

function attemptStatus(attempt) {
  const plan = state.oauth[attempt.integrationID];
  attempt.polls += 1;
  const time = { created: 1, expires: 600_001 };
  if (attempt.completed || (plan.outcome === "complete" && attempt.polls > (plan.afterPolls ?? 1))) {
    if (!attempt.stored) {
      attempt.stored = true;
      find(attempt.integrationID).connections.unshift({ type: "credential", id: `cred_oauth${next++}`, label: find(attempt.integrationID).name, method: "oauth" });
      save();
    }
    return { status: "complete", time };
  }
  if (plan.outcome === "failed" && attempt.polls > 1) { return { status: "failed", message: plan.message, time }; }
  if (plan.outcome === "expired" && attempt.polls > 1) { return { status: "expired", time }; }
  return { status: "pending", time };
}

async function handle(req, res) {
  const url = new URL(req.url, "http://127.0.0.1");
  let raw = "";
  for await (const chunk of req) { raw += chunk; }
  const body = raw === "" ? undefined : JSON.parse(raw);
  state.calls.push({ method: req.method, path: url.pathname, ...(body === undefined ? {} : { body }) });
  save();
  if (req.headers.authorization !== `Basic ${Buffer.from(`opencode:${password}`).toString("base64")}`) {
    send(res, 401, { _tag: "UnauthorizedError", message: "Unauthorized" });
    return;
  }
  const parts = url.pathname.split("/").filter((part) => part !== "").map((part) => decodeURIComponent(part));
  if (url.pathname === "/api/plugin") {
    unready -= 1;
    send(res, 200, { location: {}, data: unready >= 0 ? [] : [{ id: "opencode.provider.xai", state: { status: "active" } }] });
    return;
  }
  if (url.pathname === "/api/integration") {
    send(res, 200, { location: {}, data: unready >= 0 ? [] : state.integrations });
    return;
  }
  if (parts[0] === "api" && parts[1] === "credential" && req.method === "DELETE") {
    for (const entry of state.integrations) { entry.connections = entry.connections.filter((c) => c.id !== parts[2]); }
    save();
    send(res, 204);
    return;
  }
  if (parts[0] !== "api" || parts[1] !== "integration") { send(res, 404, { _tag: "NotFound", message: "no route" }); return; }
  const integration = find(parts[2]);
  if (integration === undefined) {
    send(res, 404, { _tag: "IntegrationNotFoundError", integrationID: parts[2], message: `Integration not found: ${parts[2]}` });
    return;
  }
  if (parts.length === 3) { send(res, 200, { location: {}, data: integration }); return; }
  if (parts[4] === "key") {
    const method = integration.methods.find((m) => m.type === "key");
    if (method === undefined) { send(res, 500); return; }
    const missing = missingField(method.form, body.answer);
    if (missing) { invalid(res, `Missing required form field: ${missing.key}`); return; }
    if (state.rejectKey) { invalid(res, `Key ${body.key} rejected`); return; }
    integration.connections.unshift({ type: "credential", id: `cred_key${next++}`, label: body.label ?? integration.name, method: "key" });
    state.storedKeys = [...state.storedKeys ?? [], { integrationID: integration.id, key: body.key, answer: body.answer }];
    save();
    send(res, 204);
    return;
  }
  if (parts[4] !== "oauth") { send(res, 404, { _tag: "NotFound", message: "no route" }); return; }
  if (parts.length === 5) {
    const method = integration.methods.find((m) => m.type === "oauth" && m.id === body.methodID);
    if (method === undefined) { send(res, 500); return; }
    const missing = missingField(method.form, body.answer);
    if (missing) { invalid(res, `Missing required form field: ${missing.key}`); return; }
    const plan = state.oauth[integration.id];
    const attemptID = `con_${next++}`;
    attempts.set(attemptID, { integrationID: integration.id, polls: 0, completed: false, stored: false });
    send(res, 200, { location: {}, data: {
      attemptID, url: plan.url, instructions: plan.instructions, mode: plan.mode ?? "auto",
      ...(plan.paste ? { paste: true } : {}), time: { created: 1000, expires: 601_000 },
    } });
    return;
  }
  const attempt = attempts.get(parts[5]);
  if (req.method === "DELETE") {
    attempts.delete(parts[5]);
    state.cancelled.push(parts[5]);
    save();
    send(res, 204);
    return;
  }
  if (attempt === undefined) {
    send(res, 404, { _tag: "IntegrationAttemptNotFoundError", integrationID: integration.id, attemptID: parts[5], message: `OAuth attempt not found: ${parts[5]}` });
    return;
  }
  if (parts[6] === "complete") {
    if (body.code !== state.oauth[integration.id].code) { invalid(res, `Invalid authorization code ${body.code}`); return; }
    attempt.completed = true;
    send(res, 204);
    return;
  }
  send(res, 200, { location: {}, data: attemptStatus(attempt) });
}

const server = createServer(async (req, res) => {
  try { await handle(req, res); } catch (error) { send(res, 500, { _tag: "Defect", message: String(error) }); }
});
server.listen(0, "127.0.0.1", () => {
  if (state.startup === "silent") { return; }
  console.log(`server listening on http://127.0.0.1:${server.address().port}`);
});
process.on("SIGTERM", () => { state.stopped = true; save(); process.exit(0); });
