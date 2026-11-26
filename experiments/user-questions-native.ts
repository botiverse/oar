/* oxlint-disable max-params, promise/prefer-await-to-then, promise/always-return -- Flat probe cases with their native sequence in one place. */
/** What Claude and Codex put on the wire for a question to the user; scripted provider, no real model calls.
 * Run: pnpm tsx experiments/user-questions-native.ts claude|codex [command]. Results: user-questions-2026-11-25.md. */
import { mkdir, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { startAppServerClient } from "../packages/oar/src/runtimes/codex/app-server-client.js";
import { spawnLineProcess } from "../packages/oar/src/shared/executable/index.js";
import { asRecord, parseJson, type JsonRecord } from "../packages/oar/src/shared/json.js";
import { startClaudeAimock, startCodexAimock } from "../sea-trial/harness/aimock.js";

const [vendor, given, only] = process.argv.slice(2);
const wanted = (name: string): boolean => only === undefined || only.split(",").includes(name);
const show = (label: string, value: unknown): void => { console.log(label, JSON.stringify(value)); };
const QUESTIONS = [
  { question: "Which color?", header: "Color", options: [{ label: "Red", description: "r" }, { label: "Blue", description: "b" }], multiSelect: false },
  { question: "Which sizes?", header: "Size", options: [{ label: "S", description: "s" }, { label: "M", description: "m" }], multiSelect: true },
];

async function claude(name: string, tool: string, input: unknown, reply: ((request: JsonRecord) => JsonRecord) | "interrupt" | "silent", extra: readonly string[] = ["--dangerously-skip-permissions"], then?: { readonly tool: string; readonly input: unknown }): Promise<void> {
  if (!wanted(name)) { return; }
  const home = await mkdtemp(path.join(tmpdir(), "oar-questions-"));
  await mkdir(path.join(home, "work"));
  let calls = 0;
  let offered: unknown = null;
  const results: unknown[] = [];
  const provider = await startClaudeAimock((mock) => {
    mock.onMessage(/[\s\S]*/u, (request) => {
      const tools = JSON.stringify(request.tools ?? []);
      if (calls === 0) { offered = ["AskUserQuestion", "EnterPlanMode", "ExitPlanMode"].filter((each) => tools.includes(`"${each}"`)); }
      calls += 1;
      const last = request.messages.findLast((message) => message.role === "tool");
      if (last !== undefined) {
        results.push(last.content);
        return then !== undefined && results.length === 1 ? { toolCalls: [{ id: "call_2", name: then.tool, arguments: JSON.stringify(then.input) }] } : { content: "done" };
      }
      return calls === 1 ? { toolCalls: [{ id: "call_1", name: tool, arguments: JSON.stringify(input) }] } : { content: "done" };
    });
  });
  const child = spawnLineProcess(given ?? "claude", ["-p", "--input-format", "stream-json", "--output-format", "stream-json", "--verbose", ...(name.startsWith("plain") ? [] : ["--permission-prompt-tool", "stdio"]), "--model", "sonnet", ...extra, "--strict-mcp-config", "--mcp-config", "{\"mcpServers\":{}}"], {
    cwd: path.join(home, "work"), env: { ...process.env, ...provider.env, HOME: home, CLAUDE_CONFIG_DIR: path.join(home, ".claude"), CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC: "1", CLAUDECODE: undefined, CLAUDE_CODE_OAUTH_TOKEN: undefined, ANTHROPIC_AUTH_TOKEN: undefined },
  });
  const done = Promise.withResolvers<string>();
  const timer = setTimeout(() => { done.resolve("TIMEOUT"); }, 15_000);
  let version: unknown = null;
  child.onLine((line) => {
    const message = asRecord(parseJson(line));
    if (message === null) { return; }
    if (message.type === "system" && message.subtype === "init") { version = message.claude_code_version; }
    if (message.type === "control_request" || message.type === "control_cancel_request") { show(`  ${name} <-`, message); }
    if (message.type === "control_response") { show(`  ${name} <-`, message); }
    if (message.type === "control_request") {
      const request = asRecord(message.request) ?? {};
      if (reply === "interrupt") { void delay(300).then(() => { child.write(`${JSON.stringify({ type: "control_request", request_id: "stop", request: { subtype: "interrupt" } })}\n`); }); }
      else if (reply !== "silent") {
        const out = { type: "control_response", response: { subtype: "success", request_id: message.request_id, response: reply(request) } };
        show(`  ${name} ->`, out);
        child.write(`${JSON.stringify(out)}\n`);
      }
    }
    if (message.type === "result") { show(`  ${name} result`, { subtype: message.subtype, is_error: message.is_error, denials: message.permission_denials }); done.resolve("result"); }
  });
  await child.spawned;
  child.write(`${JSON.stringify({ type: "user", message: { role: "user", content: "go" } })}\n`);
  const end = await done.promise;
  clearTimeout(timer);
  show(name, { version, offered, end, calls, toolResults: results });
  child.kill(); await child.exited; await provider.stop();
  await rm(home, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
}
const answers = (value: Record<string, unknown>) => (request: JsonRecord): JsonRecord => ({ behavior: "allow", updatedInput: { ...asRecord(request.input), answers: value } });

async function codex(name: string, flag: boolean, act: "answer" | "interrupt" | "kill-none", question: JsonRecord, answer: JsonRecord): Promise<void> {
  if (!wanted(name)) { return; }
  const results: unknown[] = [];
  let offered: unknown = null;
  const provider = await startCodexAimock((mock) => {
    mock.onMessage(/[\s\S]*/u, (request) => {
      offered ??= /request_user_input/u.test(JSON.stringify(request.tools ?? []));
      const last = request.messages.findLast((message) => message.role === "tool");
      if (last !== undefined) { results.push(last.content); return { content: "done" }; }
      return results.length === 0 ? { toolCalls: [{ id: "call_1", name: "request_user_input", arguments: JSON.stringify({ questions: [question] }) }] } : { content: "done" };
    });
  });
  const client = startAppServerClient(given ?? "codex", provider.env, { ...(flag ? { "features.default_mode_request_user_input": "true" } : {}), sandbox_mode: "\"danger-full-access\"" }, process.cwd());
  const done = Promise.withResolvers<string>();
  const timer = setTimeout(() => { done.resolve("TIMEOUT"); }, 15_000);
  let turn = { threadId: "", turnId: "" };
  const init = await client.request("initialize", { clientInfo: { name: "oar", version: "0.0.0" }, capabilities: { experimentalApi: true } });
  client.notify("initialized", {});
  const started = await client.request("thread/start", { cwd: process.cwd(), approvalPolicy: "never" });
  client.handle({
    onNotification: (method, params) => {
      if (["serverRequest/resolved", "turn/completed"].includes(method)) { show(`  ${name} <- ${method}`, method === "turn/completed" ? { status: asRecord(params.turn)?.status } : params); }
      if (method === "item/started" || method === "item/completed") { show(`  ${name} <- ${method}`, { type: asRecord(params.item)?.type }); }
      if (method === "turn/completed") { done.resolve("turn/completed"); }
    },
    onServerRequest: (id, method, params) => {
      show(`  ${name} <- request`, { id, method, params });
      if (act === "answer") { client.respond(id, { result: answer }); }
      else { void client.request("turn/interrupt", turn).then((reply) => { show(`  ${name} interrupt reply`, reply); }); }
    },
  });
  const threadId = String(asRecord(started.thread)?.id);
  const reply = await client.request("turn/start", { threadId, input: [{ type: "text", text: "go" }] });
  turn = { threadId, turnId: String(asRecord(reply.turn)?.id) };
  const end = await done.promise;
  clearTimeout(timer);
  await delay(300);
  show(name, { agent: init.userAgent, offered, end, toolResults: results });
  client.kill(); await client.exited; await provider.stop();
}

if (vendor === "claude") {
  await claude("bash", "Bash", { command: "echo hi" }, () => ({ behavior: "deny", message: "no" }));
  await claude("write", "Write", { file_path: "a.txt", content: "x" }, () => ({ behavior: "deny", message: "no" }));
  await claude("ask", "AskUserQuestion", { questions: QUESTIONS }, answers({ "Which color?": "Red", "Which sizes?": "S, M" }));
  await claude("ask-array", "AskUserQuestion", { questions: QUESTIONS }, answers({ "Which color?": "Red", "Which sizes?": ["S", "M"] }));
  await claude("ask-text", "AskUserQuestion", { questions: QUESTIONS }, answers({ "Which color?": "teal, please", "Which sizes?": "S, and something else" }));
  await claude("ask-partial", "AskUserQuestion", { questions: QUESTIONS }, answers({ "Which color?": "Red" }));
  await claude("ask-deny", "AskUserQuestion", { questions: QUESTIONS }, () => ({ behavior: "deny", message: "The user declined to answer." }));
  await claude("ask-interrupt", "AskUserQuestion", { questions: QUESTIONS }, "interrupt");
  await claude("exit-plan", "ExitPlanMode", { plan: "do it" }, () => ({ behavior: "deny", message: "Not an approval interface." }));
  await claude("enter-plan", "EnterPlanMode", {}, () => ({ behavior: "deny", message: "Not an approval interface." }));
  await claude("plain", "Bash", { command: "echo hi" }, "silent");
  await claude("plain-plan", "EnterPlanMode", {}, "silent");
  await claude("plan-exit", "EnterPlanMode", {}, () => ({ behavior: "deny", message: "Not an approval interface." }), undefined, { tool: "ExitPlanMode", input: { plan: "do it" } });
  await claude("plan-write", "EnterPlanMode", {}, () => ({ behavior: "deny", message: "Not an approval interface." }), undefined, { tool: "Write", input: { file_path: "a.txt", content: "x" } });
  await claude("no-plan", "EnterPlanMode", {}, () => ({ behavior: "deny", message: "x" }), ["--dangerously-skip-permissions", "--disallowed-tools", "EnterPlanMode", "ExitPlanMode"]);
  await claude("no-flag-ask", "AskUserQuestion", { questions: QUESTIONS }, "silent", ["--dangerously-skip-permissions", "--permission-prompts", "none"]);
} else {
  const q = { id: "color", header: "Color", question: "Which color?", options: [{ label: "Red (Recommended)", description: "r" }, { label: "Blue", description: "b" }] };
  await codex("flag-off", false, "answer", q, { answers: { color: { answers: ["Blue"] } } });
  await codex("one", true, "answer", q, { answers: { color: { answers: ["Blue"] } } });
  await codex("text", true, "answer", q, { answers: { color: { answers: ["user_note: teal"] } } });
  await codex("two", true, "answer", q, { answers: { color: { answers: ["Blue", "user_note: but dark"] } } });
  await codex("declined", true, "answer", q, { answers: {} });
  await codex("interrupt", true, "interrupt", q, {});
}
process.exit(0);
