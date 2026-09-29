/**
 * APPROVAL CHANNELS: how each runtime asks its host to approve an action or
 * answer a question, how an answer given LATER is taken, and what becomes of
 * a request still pending when the turn is interrupted. The native evidence
 * behind `SessionOptions.approvals: "ask"` and `Session.answer`
 * (docs/runtimes/claude.md, codex.md "Tools, permissions").
 *
 * Run: pnpm tsx experiments/approval-channels.ts [claude|codex|all]
 * Token-free: the real binaries run against a local scripted provider
 * (aimock). OAR_PROBE_WAIT_MS sets how long the first answer is held back
 * (20 s); OAR_PROBE_CODEX_POLICY swaps codex's approval policy (untrusted).
 * grok and kimi (ACP) need their real login: approval-channels-acp.ts; what
 * it observed is recorded below.
 *
 * ── OBSERVED 2026-09-29, darwin arm64: claude 2.1.284, codex-cli 0.155.1,
 *    kimi 2.0.0, grok 1.0.44 ──
 *
 * claude, `--permission-mode default --permission-prompt-tool stdio`, no
 * initialize handshake needed: `system/init` says `permissionMode:
 * "default"`; a Bash `touch` is `assistant` (tool_use) then `control_request
 * {request_id, request: {subtype: "can_use_tool", tool_name: "Bash",
 * display_name, input, description, permission_suggestions: [addRules
 * (destination localSettings), addDirectories (session), setMode acceptEdits
 * (session)], blocked_path, tool_use_id}}`. An allow sent 20 s later ran the
 * tool; one sent 300 s later (OAR_PROBE_WAIT_MS=300000) too, with no frame
 * at all in between. `{behavior: "allow"}` without
 * `updatedInput` also runs it. `{behavior: "deny", message}` → the model reads
 * the message verbatim as an `is_error` tool_result, the turn completes, and
 * `result.permission_denials` lists the call; a deny with no message still
 * denies, but the model reads "The canUseTool callback returned an invalid
 * permission result. Expected {behavior: 'allow', updatedInput?: object} or
 * {behavior: 'deny', message: string}.". `updatedPermissions: [addRules …
 * destination "session"]` → the same command later ran with no request.
 * AskUserQuestion is a can_use_tool with `requires_user_interaction: true`
 * and `input.questions`; `updatedInput: {...input, answers: {<question>:
 * "Blue", <question>: "Small, Large"}}` → the model reads "Your questions have
 * been answered: "<q>"="Blue", "<q>"="Small, Large". …". An interrupt while a
 * request is pending: `control_cancel_request {request_id}` for it, then the
 * interrupt's control_response, a rejected tool_result, the result frame; a
 * later answer to it is ignored (no frame).
 *
 * codex, thread/start `approvalPolicy: "untrusted", approvalsReviewer:
 * "user"` (reply echoes both; sandbox dangerFullAccess): an `exec_command`
 * `touch` is `item/started` (commandExecution) then the server request
 * `item/commandExecution/requestApproval` (JSON-RPC id 0, 1, 2 … per
 * connection) `{kind: "command", threadId, turnId, itemId, startedAtMs,
 * environmentId, command: "/bin/zsh -lc 'touch …'", cwd, commandActions,
 * proposedExecpolicyAmendment, availableDecisions: ["accept",
 * {acceptWithExecpolicyAmendment}, "cancel"]}`. An accept 20 s later ran it.
 * `decline` (not listed, still honored) → item `declined`, the model reads
 * `exec_command failed: CreateProcess { message: "Rejected(\"rejected by
 * user\")" }`, turn completed. `acceptForSession` (not listed, still
 * honored) → the same command later ran unasked. `cancel` → item declined,
 * the model reads "aborted by user", turn/completed `interrupted`.
 * `serverRequest/resolved {threadId, requestId}` follows every resolution.
 * turn/interrupt while pending: reply {}, turn/completed `interrupted`, then
 * `serverRequest/resolved` for it; a later answer is ignored. A fresh
 * app-server's thread/resume with `approvalPolicy: "untrusted"` asks again.
 * `approvalPolicy: "on-request"` under danger-full-access asked for nothing.
 * `request_user_input` is offered to the model but refused ("request_user_input
 * is unavailable in Default mode"); `apply_patch` is not a tool this
 * provider config gets ("unsupported call: apply_patch").
 *
 * kimi (session mode `default`, the one it opens in): the model's Bash call
 * is `session/request_permission {toolCall: {toolCallId, title: "Bash",
 * content: [{type: "content", content: {type: "text", text: "Requesting
 * approval to Running: touch …"}}]}, options: [{approve_once, "Approve
 * once", allow_once}, {approve_always, "Approve for this session",
 * allow_always}, {reject, "Reject", reject_once}]}`, with no rawInput (the
 * arguments stream as tool_call_update content before it). `reject` → the
 * turn completed, the file absent, the model saying the request was
 * rejected.
 * grok, under this machine's `~/.grok/config.toml` `permission_mode =
 * "always-approve"`: with `--always-approve` dropped, the top-level
 * `grok --permission-mode default agent … stdio` and `_meta.yoloMode: false`,
 * no request came and the file was created; with
 * `GROK_DEFAULT_PERMISSION_MODE=default` added, the same. Its
 * `_x.ai/settings/update` push says `permission_mode: null`: no mode in
 * effect is reported.
 */
/* oxlint-disable eslint/no-await-in-loop, eslint/max-lines-per-function -- a probe script: scenarios run one at a time, in order */
import { spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { createInterface } from "node:readline";
import { setTimeout as delay } from "node:timers/promises";
import { asRecord, parseJson, type JsonRecord } from "../packages/oar/src/shared/json.js";
import { startClaudeAimock, startCodexAimock } from "../sea-trial/harness/aimock.js";

const which = process.argv[2] ?? "all";

interface JsonLinesChild {
  send(message: JsonRecord): void;
  /** The first message since index `from` the predicate accepts, or null after `ms`. */
  next(from: number, predicate: (message: JsonRecord) => boolean, ms?: number): Promise<JsonRecord | null>;
  readonly seen: JsonRecord[];
  stop(): Promise<number | null>;
}

function jsonLines(command: string, args: readonly string[], options: { readonly env: NodeJS.ProcessEnv; readonly cwd: string }): JsonLinesChild {
  const child = spawn(command, [...args], { env: options.env, cwd: options.cwd, stdio: ["pipe", "pipe", "ignore"] });
  const seen: JsonRecord[] = [];
  const waiters: { readonly accepts: (message: JsonRecord) => boolean; readonly resolve: (message: JsonRecord | null) => void }[] = [];
  createInterface({ input: child.stdout }).on("line", (line) => {
    const message = asRecord(parseJson(line));
    if (message === null) {
      return;
    }
    seen.push(message);
    for (const waiter of waiters.filter((candidate) => candidate.accepts(message))) {
      waiters.splice(waiters.indexOf(waiter), 1);
      waiter.resolve(message);
    }
  });
  const { promise: exited, resolve: onExit } = Promise.withResolvers<number | null>();
  child.on("exit", (code) => {
    onExit(code);
  });
  return {
    seen,
    send(message) {
      child.stdin.write(`${JSON.stringify(message)}\n`);
    },
    async next(from, predicate, ms = 60_000) {
      const already = seen.slice(from).find((message) => predicate(message));
      if (already !== undefined) {
        return already;
      }
      const { promise, resolve } = Promise.withResolvers<JsonRecord | null>();
      waiters.push({ accepts: predicate, resolve });
      const timer = setTimeout(() => {
        resolve(null);
      }, ms);
      const message = await promise;
      clearTimeout(timer);
      return message;
    },
    async stop() {
      child.stdin.end();
      child.kill();
      const code = await exited;
      return code;
    },
  };
}

function short(value: unknown, limit = 1200): string {
  const text = value === undefined ? "undefined" : JSON.stringify(value);
  return text.length > limit ? `${text.slice(0, limit)}…` : text;
}

function label(message: JsonRecord): string {
  if (typeof message.method === "string") {
    return message.method;
  }
  const type = typeof message.type === "string" ? message.type : `reply#${short(message.id)}`;
  return typeof message.subtype === "string" ? `${type}/${message.subtype}` : type;
}

const WAIT_MS = Number(process.env.OAR_PROBE_WAIT_MS ?? 20_000);

// ─── claude ────────────────────────────────────────────────────────────────

function bash(command: string): { toolCalls: { name: string; arguments: string }[] } {
  return { toolCalls: [{ name: "Bash", arguments: JSON.stringify({ command, description: "probe" }) }] };
}

const QUESTIONS = [
  { question: "Which color should the button be?", header: "Color", multiSelect: false, options: [{ label: "Red", description: "warm" }, { label: "Blue", description: "cool" }] },
  { question: "Which sizes should ship?", header: "Sizes", multiSelect: true, options: [{ label: "Small", description: "s" }, { label: "Large", description: "l" }] },
];

function isCanUseTool(message: JsonRecord): boolean {
  return message.type === "control_request" && asRecord(message.request)?.subtype === "can_use_tool";
}

function toolResultsOf(messages: readonly JsonRecord[]): unknown[] {
  return messages.filter((message) => message.type === "user").flatMap((message): unknown[] => {
    const content: unknown = asRecord(message.message)?.content;
    return Array.isArray(content) ? content.filter((block: unknown) => asRecord(block)?.type === "tool_result") : [];
  });
}

async function probeClaude(): Promise<void> {
  const work = await mkdtemp(path.join(tmpdir(), "oar-approval-claude-"));
  const target = path.join(work, "oar-probe-file");
  const env = await startClaudeAimock((mock) => {
    for (const [prompt, file] of [["probe-allow", ""], ["probe-deny", "-denied"], ["probe-bare-allow", "-bare"], ["probe-bare-deny", "-bare-denied"], ["probe-session", "-session"], ["probe-again", "-session"], ["probe-interrupt", "-interrupted"]] as const) {
      mock.on({ userMessage: new RegExp(`${prompt}$`, "u"), hasToolResult: false }, bash(`touch ${target}${file}`));
    }
    mock.on({ userMessage: /probe-question/u, hasToolResult: false }, { toolCalls: [{ name: "AskUserQuestion", arguments: JSON.stringify({ questions: QUESTIONS }) }] });
    mock.on({ hasToolResult: true }, { content: "done" });
    mock.onMessage(/[\s\S]*/u, { content: "ok" });
  });
  const claude = jsonLines("claude", [
    "-p", "--input-format", "stream-json", "--output-format", "stream-json", "--verbose", "--replay-user-messages",
    "--permission-mode", "default", "--permission-prompt-tool", "stdio", "--session-id", randomUUID(),
  ], { env: { ...process.env, CLAUDECODE: undefined, ...env.env }, cwd: work });
  const turn = async (text: string, answer: (request: JsonRecord) => JsonRecord, waitMs = 0): Promise<void> => {
    const from = claude.seen.length;
    claude.send({ type: "user", message: { role: "user", content: [{ type: "text", text }] } });
    const asked = await claude.next(from, (message) => isCanUseTool(message) || message.type === "result");
    if (asked !== null && isCanUseTool(asked)) {
      console.log(`claude ${text}: ${short(asked)}`);
      await delay(waitMs);
      claude.send({ type: "control_response", response: { subtype: "success", request_id: asked.request_id, response: answer(asRecord(asked.request) ?? {}) } });
    }
    const result = await claude.next(from, (message) => message.type === "result");
    const frames = claude.seen.slice(from);
    const init = frames.find((message) => label(message) === "system/init");
    console.log(`claude ${text}: permissionMode ${short(init?.permissionMode)}; frames ${frames.map((message) => label(message)).join(" ")}`);
    console.log(`claude ${text}: result ${short({ subtype: result?.subtype, is_error: result?.is_error, permission_denials: result?.permission_denials })}`);
    console.log(`claude ${text}: tool_result ${short(toolResultsOf(frames), 700)}`);
  };
  try {
    await turn("probe-allow", (request) => ({ behavior: "allow", updatedInput: request.input }), WAIT_MS);
    await turn("probe-deny", () => ({ behavior: "deny", message: "not now, ask me tomorrow" }));
    await turn("probe-bare-allow", () => ({ behavior: "allow" }));
    await turn("probe-bare-deny", () => ({ behavior: "deny" }));
    await turn("probe-session", (request) => ({
      behavior: "allow",
      updatedInput: request.input,
      updatedPermissions: [{ type: "addRules", rules: [{ toolName: "Bash", ruleContent: `touch ${target}-session` }], behavior: "allow", destination: "session" }],
    }));
    await turn("probe-again", () => ({ behavior: "deny", message: "should not be asked" }));
    await turn("probe-question", (request) => ({
      behavior: "allow",
      updatedInput: { ...asRecord(request.input), answers: { "Which color should the button be?": "Blue", "Which sizes should ship?": "Small, Large" } },
    }));
    // Interrupt while the approval is pending, then answer it anyway.
    const from = claude.seen.length;
    claude.send({ type: "user", message: { role: "user", content: [{ type: "text", text: "probe-interrupt" }] } });
    const pending = await claude.next(from, (message) => isCanUseTool(message));
    claude.send({ type: "control_request", request_id: "probe-interrupt-1", request: { subtype: "interrupt" } });
    await claude.next(from, (message) => message.type === "result");
    await delay(500);
    console.log(`claude probe-interrupt: ${claude.seen.slice(from).map((message) => label(message)).join(" ")}`);
    console.log(`claude probe-interrupt: ${short(claude.seen.slice(from).find((message) => message.type === "control_cancel_request"))}`);
    const late = claude.seen.length;
    claude.send({ type: "control_response", response: { subtype: "success", request_id: pending?.request_id, response: { behavior: "allow" } } });
    await delay(1000);
    console.log(`claude late answer: ${claude.seen.slice(late).map((message) => label(message)).join(" ") || "no frame"}`);
  } finally {
    await claude.stop();
    await env.stop();
    await rm(work, { recursive: true, force: true });
  }
}

// ─── codex (app-server) ────────────────────────────────────────────────────

function exec(cmd: string): { toolCalls: { name: string; arguments: string }[] } {
  return { toolCalls: [{ name: "exec_command", arguments: JSON.stringify({ cmd }) }] };
}

function isServerRequest(message: JsonRecord): boolean {
  return message.id !== undefined && typeof message.method === "string";
}

function turnStatus(message: JsonRecord | null): unknown {
  return asRecord(asRecord(message?.params)?.turn)?.status;
}

/** One app-server connection and its JSON-RPC request helper. */
async function openCodex(env: NodeJS.ProcessEnv, cwd: string): Promise<{ readonly codex: JsonLinesChild; readonly rpc: (method: string, params: JsonRecord) => Promise<JsonRecord> }> {
  const codex = jsonLines("codex", ["app-server", "-c", 'sandbox_mode="danger-full-access"', "--listen", "stdio://"], { env, cwd });
  let rpcId = 0;
  const rpc = async (method: string, params: JsonRecord): Promise<JsonRecord> => {
    rpcId += 1;
    const id = rpcId;
    const answered = codex.next(0, (message) => message.id === id && message.method === undefined);
    codex.send({ id, method, params });
    const answer = await answered;
    return asRecord(answer?.result) ?? { error: answer?.error ?? "no answer" };
  };
  await rpc("initialize", { clientInfo: { name: "oar-probe", version: "0.0.0" }, capabilities: { experimentalApi: true } });
  codex.send({ method: "initialized", params: {} });
  return { codex, rpc };
}

async function probeCodex(): Promise<void> {
  const work = await mkdtemp(path.join(tmpdir(), "oar-approval-codex-"));
  const target = path.join(work, "oar-probe-file");
  const policy = process.env.OAR_PROBE_CODEX_POLICY ?? "untrusted";
  const aimock = await startCodexAimock((mock) => {
    for (const [prompt, file] of [["probe-accept", ""], ["probe-decline", "-declined"], ["probe-session", "-session"], ["probe-again", "-session"], ["probe-cancel", "-cancelled"], ["probe-interrupt", "-interrupted"]] as const) {
      mock.on({ userMessage: new RegExp(prompt, "u"), hasToolResult: false }, exec(`touch ${target}${file}`));
    }
    mock.on({ userMessage: /probe-question/u, hasToolResult: false }, { toolCalls: [{ name: "request_user_input", arguments: JSON.stringify({ questions: [{ id: "color", header: "Color", question: "Which color?", options: [{ label: "Red", description: "warm" }] }] }) }] });
    mock.on({ hasToolResult: true }, { content: "done" });
    mock.onMessage(/[\s\S]*/u, { content: "ok" });
  });
  const env = { ...process.env, ...aimock.env };
  const { codex, rpc } = await openCodex(env, work);
  const turn = async (threadId: string, text: string, decide: () => JsonRecord): Promise<void> => {
    const from = codex.seen.length;
    await rpc("turn/start", { threadId, input: [{ type: "text", text }] });
    const asked = await codex.next(from, (message) => isServerRequest(message) || message.method === "turn/completed");
    if (asked !== null && isServerRequest(asked)) {
      console.log(`codex ${text}: ${short(asked, 1500)}`);
      await delay(text === "probe-accept" ? WAIT_MS : 0);
      codex.send({ id: asked.id, result: decide() });
    }
    const done = await codex.next(from, (message) => message.method === "turn/completed");
    const frames = codex.seen.slice(from).map((message) => label(message)).filter((method) => !/delta|rawResponseItem|tokenUsage|rateLimits|mcpServer/u.test(method));
    const outputs = codex.seen.slice(from).map((message) => asRecord(asRecord(message.params)?.item)).filter((item) => typeof item?.type === "string" && item.type.endsWith("_output"));
    console.log(`codex ${text}: turn ${short(turnStatus(done))}; frames ${frames.join(" ")}`);
    console.log(`codex ${text}: the model saw ${short(outputs.map((item) => item?.output), 600)}`);
  };
  try {
    const thread = await rpc("thread/start", { cwd: work, approvalPolicy: policy, approvalsReviewer: "user", experimentalRawEvents: true });
    const threadId = String(asRecord(thread.thread)?.id);
    console.log(`codex thread/start ${policy} → approvalPolicy ${short(thread.approvalPolicy)} reviewer ${short(thread.approvalsReviewer)} sandbox ${short(thread.sandbox)}`);
    await turn(threadId, "probe-accept", () => ({ decision: "accept" }));
    await turn(threadId, "probe-decline", () => ({ decision: "decline" }));
    await turn(threadId, "probe-session", () => ({ decision: "acceptForSession" }));
    await turn(threadId, "probe-again", () => ({ decision: "decline" }));
    await turn(threadId, "probe-cancel", () => ({ decision: "cancel" }));
    await turn(threadId, "probe-question", () => ({ answers: { color: { answers: ["Red"] } } }));
    // Interrupt while the approval is pending, then answer it anyway.
    const from = codex.seen.length;
    const started = await rpc("turn/start", { threadId, input: [{ type: "text", text: "probe-interrupt" }] });
    const pending = await codex.next(from, (message) => isServerRequest(message));
    const interrupted = await rpc("turn/interrupt", { threadId, turnId: asRecord(started.turn)?.id });
    const done = await codex.next(from, (message) => message.method === "turn/completed");
    await delay(500);
    console.log(`codex probe-interrupt: reply ${short(interrupted)}, turn ${short(turnStatus(done))}; ${codex.seen.slice(from).map((message) => label(message)).filter((method) => !/delta|rawResponseItem|tokenUsage|rateLimits/u.test(method)).join(" ")}`);
    console.log(`codex serverRequest/resolved: ${short(codex.seen.filter((message) => message.method === "serverRequest/resolved").map((message) => message.params))}`);
    const late = codex.seen.length;
    codex.send({ id: pending?.id, result: { decision: "accept" } });
    await delay(1000);
    console.log(`codex late answer: ${codex.seen.slice(late).map((message) => label(message)).join(" ") || "no frame"}`);
    await codex.stop();
    // A thread resumed on a fresh app-server takes the policy of the resume.
    const resumed = await openCodex(env, work);
    const reply = await resumed.rpc("thread/resume", { threadId, excludeTurns: true, cwd: work, approvalPolicy: "untrusted", approvalsReviewer: "user" });
    const again = resumed.codex.seen.length;
    await resumed.rpc("turn/start", { threadId, input: [{ type: "text", text: "probe-decline again" }] });
    const asked = await resumed.codex.next(again, (message) => isServerRequest(message) || message.method === "turn/completed");
    console.log(`codex thread/resume untrusted → approvalPolicy ${short(reply.approvalPolicy)}; next command: ${asked === null ? "nothing" : label(asked)}`);
    if (asked !== null && isServerRequest(asked)) {
      resumed.codex.send({ id: asked.id, result: { decision: "decline" } });
    }
    await resumed.codex.next(again, (message) => message.method === "turn/completed");
    await resumed.codex.stop();
  } finally {
    await codex.stop();
    await aimock.stop();
    await rm(work, { recursive: true, force: true });
  }
}

if (which === "claude" || which === "all") {
  await probeClaude();
}
if (which === "codex" || which === "all") {
  await probeCodex();
}
if (which === "grok" || which === "kimi") {
  console.log("grok and kimi need a real login: pnpm tsx experiments/approval-channels-acp.ts <grok|kimi>");
}
