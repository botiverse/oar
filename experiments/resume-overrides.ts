/**
 * RESUME OVERRIDES: what each runtime does with a changed model or system
 * prompt when a session is resumed (issue #22). The native evidence behind
 * the resume row of SessionOptions (contracts/session.ts) and
 * docs/runtimes/<id>.md.
 *
 * Run: unset PI_PACKAGE_DIR && pnpm tsx experiments/resume-overrides.ts [claude|codex|acp|grok-prompt|all]
 * claude and codex run their turns against a local scripted provider (aimock)
 * behind a raw-body capture, so the request that reached the provider is
 * read, not inferred. grok and kimi use real logins and no prompt.
 *
 * ── OBSERVED 2026-09-30: claude 2.1.284, codex-cli 0.158.0, grok 1.0.44,
 *    Kimi Code CLI 0.38.0 (agentInfo) ──
 * claude:
 * - `--model` applies on `--resume` as on a new session. `get_settings`
 *   answers `applied.model`: an alias resolved (haiku →
 *   claude-haiku-4-5-20251001, as the list_models row says), a full ID or an
 *   unknown name echoed. The turn's system/init and the provider request
 *   both carry that model.
 * - `--system-prompt` / `--append-system-prompt` on `--resume` are ignored:
 *   the turn runs the prompts snapshotted at the session's start. With
 *   `--system-prompt-snapshot off` the new ones reach the provider. A later
 *   resume without flags runs the snapshot (the first prompts) again.
 * codex:
 * - `thread/resume {model}` switches the model, and it persists: a later
 *   resume without one keeps it. The switch inserts a `<model_switch>`
 *   developer item quoting the instructions in force, resent on later turns.
 * - `baseInstructions` on thread/resume replaces `instructions` for that
 *   process only: a later resume without it runs the thread's first ones.
 * - `developerInstructions` on thread/resume is dropped: the turn carries
 *   only the thread's original developer item.
 * grok (ACP, real login):
 * - `session/load` reports the persisted model (configOptions and
 *   models.currentModelId). `session/set_model` after it answers
 *   `_meta.model {Ok: id}`, then pushes `config_option_update`; an unknown
 *   id is -32602 "unknown model id".
 * - `_meta.systemPromptOverride` on initialize applies to a loaded session.
 *   `_meta.rules` alone is folded into grok's own template at session/new
 *   only; on a load the session keeps its first rules. With an override,
 *   rules are not used at all.
 * kimi (ACP, real login):
 * - `session/resume` reports the persisted model (configOptions `model`).
 *   `session/set_model` pushes `config_option_update` with the new id, then
 *   answers `{}`; an unknown id is -32603 "not configured in config.toml".
 */
/* oxlint-disable eslint/no-await-in-loop -- the probes run one process at a time, in order */
import { spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import { createInterface } from "node:readline";
import { setTimeout as delay } from "node:timers/promises";
import { asRecord, asRecordList, parseJson, type JsonRecord } from "../packages/oar/src/shared/json.js";
import { startClaudeAimock, startCodexAimock, type AimockEnv } from "../sea-trial/harness/aimock.js";

const which = process.argv[2] ?? "all";

interface JsonLinesChild {
  send(message: JsonRecord): void;
  next(predicate: (message: JsonRecord) => boolean, ms?: number): Promise<JsonRecord | null>;
  readonly seen: JsonRecord[];
  stop(): Promise<void>;
}

function jsonLines(command: string, args: readonly string[], env: NodeJS.ProcessEnv = process.env): JsonLinesChild {
  const child = spawn(command, [...args], { env, stdio: ["pipe", "pipe", "pipe"] });
  child.stderr.on("data", (chunk: Buffer) => {
    const text = chunk.toString("utf8").trim();
    if (text.length > 0) {
      console.log(`  [stderr ${command}] ${text.slice(0, 300)}`);
    }
  });
  const seen: JsonRecord[] = [];
  const waiters: { predicate: (message: JsonRecord) => boolean; resolve: (message: JsonRecord | null) => void }[] = [];
  createInterface({ input: child.stdout }).on("line", (line) => {
    const message = asRecord(parseJson(line));
    if (message === null) {
      return;
    }
    seen.push(message);
    for (const waiter of waiters.filter((candidate) => candidate.predicate(message))) {
      waiters.splice(waiters.indexOf(waiter), 1);
      waiter.resolve(message);
    }
  });
  const { promise: exited, resolve: onExit } = Promise.withResolvers<void>();
  child.on("exit", () => {
    onExit();
    for (const waiter of waiters.splice(0)) {
      waiter.resolve(null);
    }
  });
  return {
    seen,
    send(message) {
      child.stdin.write(`${JSON.stringify(message)}\n`);
    },
    async next(predicate, ms = 30_000) {
      const { promise, resolve } = Promise.withResolvers<JsonRecord | null>();
      waiters.push({ predicate, resolve });
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
      await exited;
    },
  };
}

// ─── claude ────────────────────────────────────────────────────────────────

async function claudeControl(claude: JsonLinesChild, request: JsonRecord): Promise<JsonRecord | null> {
  const id = `probe-${randomUUID()}`;
  const answered = claude.next((message) => message.type === "control_response" && asRecord(message.response)?.request_id === id);
  claude.send({ type: "control_request", request_id: id, request });
  const answer = await answered;
  return asRecord(answer?.response);
}

async function claudeAppliedModel(claude: JsonLinesChild): Promise<string> {
  const answer = await claudeControl(claude, { subtype: "get_settings" });
  if (answer === null) {
    return "(no answer)";
  }
  if (answer.subtype !== "success") {
    return `(error ${JSON.stringify(answer.error)})`;
  }
  return JSON.stringify(asRecord(asRecord(answer.response)?.applied)?.model);
}

function claudeProcess(env: NodeJS.ProcessEnv, args: readonly string[]): JsonLinesChild {
  return jsonLines("claude", [
    "-p", "--input-format", "stream-json", "--output-format", "stream-json", "--verbose",
    "--dangerously-skip-permissions", ...args,
  ], { ...process.env, CLAUDECODE: undefined, ...env });
}

function systemText(body: unknown): string {
  const system = asRecord(body)?.system;
  const text = typeof system === "string" ? system : asRecordList(system).map((block) => String(block.text)).join(" | ");
  const marks = ["ALPHA-PROMPT", "BETA-PROMPT", "GAMMA-APPEND", "DELTA-APPEND"].filter((mark) => text.includes(mark));
  return marks.length > 0 ? marks.join(",") : "(no marker)";
}

async function claudeTurn(claude: JsonLinesChild, aimock: AimockEnv): Promise<string> {
  const before = aimock.raw.length;
  const init = claude.next((message) => message.type === "system" && message.subtype === "init", 60_000);
  const result = claude.next((message) => message.type === "result", 60_000);
  claude.send({ type: "user", message: { role: "user", content: "say ok" } });
  const initModel = asRecord(await init)?.model;
  const done = await result;
  const turns = aimock.raw.slice(before).filter((request) => request.path.includes("/messages") && asRecordList(asRecord(request.body)?.messages).length > 0);
  const last = turns.at(-1)?.body;
  return `init.model=${String(initModel)} result=${String(done?.subtype)} provider.model=${String(asRecord(last)?.model)} system=${systemText(last)}`;
}

async function probeClaude(): Promise<void> {
  // listModels as oar sees it: value (the selector) vs resolvedModel.
  const lister = claudeProcess({}, []);
  const listed = await claudeControl(lister, { subtype: "list_models" });
  await lister.stop();
  const rows = asRecordList(asRecord(listed?.response)?.models).map((row) => `${String(row.value)}→${String(row.resolvedModel)}`);
  console.log(`claude list_models: ${rows.join(", ")}`);

  // Token-free readback for several spellings.
  for (const model of ["haiku", "sonnet", "claude-haiku-4-5-20251001", "claude-haiku-4-5", "bogus-model-x"]) {
    const claude = claudeProcess({}, ["--session-id", randomUUID(), "--model", model]);
    console.log(`claude --model ${model} → applied.model ${await claudeAppliedModel(claude)}`);
    await claude.stop();
  }

  const aimock = await startClaudeAimock(undefined, { captureRaw: true });
  try {
    const sessionId = randomUUID();
    const first = claudeProcess(aimock.env ?? {}, [
      "--session-id", sessionId, "--model", "haiku",
      "--system-prompt", "ALPHA-PROMPT", "--append-system-prompt", "GAMMA-APPEND",
    ]);
    console.log(`claude open haiku: applied ${await claudeAppliedModel(first)}; turn ${await claudeTurn(first, aimock)}`);
    await first.stop();

    const resumed = claudeProcess(aimock.env ?? {}, [
      "--resume", sessionId, "--model", "sonnet",
      "--system-prompt", "BETA-PROMPT", "--append-system-prompt", "DELTA-APPEND",
    ]);
    console.log(`claude resume sonnet+BETA+DELTA: applied ${await claudeAppliedModel(resumed)}; turn ${await claudeTurn(resumed, aimock)}`);
    await resumed.stop();

    // The same resume with the prompt snapshot off: the new prompts land.
    const unsnapped = claudeProcess(aimock.env ?? {}, [
      "--resume", sessionId, "--model", "sonnet", "--system-prompt-snapshot", "off",
      "--system-prompt", "BETA-PROMPT", "--append-system-prompt", "DELTA-APPEND",
    ]);
    console.log(`claude resume sonnet+BETA+DELTA, snapshot off: applied ${await claudeAppliedModel(unsnapped)}; turn ${await claudeTurn(unsnapped, aimock)}`);
    await unsnapped.stop();

    const plain = claudeProcess(aimock.env ?? {}, ["--resume", sessionId]);
    console.log(`claude resume no flags: applied ${await claudeAppliedModel(plain)}; turn ${await claudeTurn(plain, aimock)}`);
    await plain.stop();
  } finally {
    await aimock.stop();
  }
}

// ─── codex (scripted provider) ─────────────────────────────────────────────

function marksIn(value: unknown): string {
  const text = value === undefined ? "" : JSON.stringify(value);
  return ["ALPHA-PROMPT", "BETA-PROMPT", "GAMMA-APPEND", "DELTA-APPEND"].filter((mark) => text.includes(mark)).join(",") || "-";
}

function instructionsOf(body: unknown): string {
  const record = asRecord(body);
  // Developer instructions travel as developer-role input items; history
  // keeps earlier ones, so each item is reported in order.
  const developer = asRecordList(record?.input).filter((item) => item.role === "developer").map((item) => marksIn(item));
  return `model=${String(record?.model)} instructions=${marksIn(record?.instructions)} developerItems=[${developer.join(" ")}]`;
}

async function probeCodex(): Promise<void> {
  const aimock = await startCodexAimock(undefined, { captureRaw: true });
  const env = { ...process.env, ...aimock.env };
  let id = 0;
  const open = (): { codex: JsonLinesChild; rpc: (method: string, params: JsonRecord) => Promise<JsonRecord> } => {
    const codex = jsonLines("codex", ["app-server"], env);
    const rpc = async (method: string, params: JsonRecord): Promise<JsonRecord> => {
      id += 1;
      const current = id;
      const answered = codex.next((message) => message.id === current && message.method === undefined, 60_000);
      codex.send({ id: current, method, params });
      const answer = await answered;
      return asRecord(answer?.result) ?? { error: answer?.error ?? "no answer" };
    };
    return { codex, rpc };
  };
  const turn = async (child: { codex: JsonLinesChild; rpc: (method: string, params: JsonRecord) => Promise<JsonRecord> }, threadId: string): Promise<string> => {
    const before = aimock.raw.length;
    const done = child.codex.next((message) => message.method === "turn/completed", 60_000);
    await child.rpc("turn/start", { threadId, input: [{ type: "text", text: "say ok", text_elements: [] }] });
    await done;
    const last = aimock.raw.slice(before).at(-1)?.body;
    return instructionsOf(last);
  };
  try {
    const first = open();
    await first.rpc("initialize", { clientInfo: { name: "oar-probe", version: "0.0.0" } });
    const started = await first.rpc("thread/start", {
      cwd: process.cwd(), model: "gpt-5.1", approvalPolicy: "never",
      baseInstructions: "ALPHA-PROMPT", developerInstructions: "GAMMA-APPEND",
    });
    const threadId = String(asRecord(started.thread)?.id);
    console.log(`codex thread/start gpt-5.1+ALPHA+GAMMA → model ${String(started.model)}; turn ${await turn(first, threadId)}`);
    await first.codex.stop();

    const second = open();
    await second.rpc("initialize", { clientInfo: { name: "oar-probe", version: "0.0.0" } });
    const resumed = await second.rpc("thread/resume", {
      threadId, cwd: process.cwd(), model: "gpt-5.5", approvalPolicy: "never",
      baseInstructions: "BETA-PROMPT", developerInstructions: "DELTA-APPEND",
    });
    console.log(`codex thread/resume gpt-5.5+BETA+DELTA → model ${String(resumed.model)} ${"error" in resumed ? JSON.stringify(resumed.error) : ""}; turn ${await turn(second, threadId)}`);
    await second.codex.stop();

    const third = open();
    await third.rpc("initialize", { clientInfo: { name: "oar-probe", version: "0.0.0" } });
    const plain = await third.rpc("thread/resume", { threadId, cwd: process.cwd(), approvalPolicy: "never" });
    console.log(`codex thread/resume (no overrides) → model ${String(plain.model)}; turn ${await turn(third, threadId)}`);
    await third.codex.stop();
  } finally {
    await aimock.stop();
  }
}

// ─── ACP: grok, kimi ───────────────────────────────────────────────────────

async function acpOpen(runtime: "grok" | "kimi", grokMeta: JsonRecord = {}): Promise<{ acp: JsonLinesChild; rpc: (method: string, params: JsonRecord) => Promise<JsonRecord> }> {
  const args = runtime === "grok" ? ["agent", "--always-approve", "--no-leader", "stdio"] : ["acp"];
  const acp = jsonLines(runtime, args);
  let id = 0;
  const rpc = async (method: string, params: JsonRecord): Promise<JsonRecord> => {
    id += 1;
    const current = id;
    const answered = acp.next((message) => message.id === current && message.method === undefined, 60_000);
    acp.send({ jsonrpc: "2.0", id: current, method, params });
    const answer = await answered;
    return asRecord(answer?.result) ?? { error: answer?.error ?? "no answer" };
  };
  const initialized = await rpc("initialize", {
    protocolVersion: 1,
    clientCapabilities: { fs: { readTextFile: false, writeTextFile: false }, terminal: true },
    clientInfo: { name: "oar-probe", version: "0.0.0" },
    ...(runtime === "grok" ? { _meta: { clientIdentifier: "oar", clientType: "generic", startupHints: { nonInteractive: true, skipGitStatus: true, skipProjectLayout: true }, ...grokMeta } } : {}),
  });
  // oxlint-disable-next-line eslint/no-underscore-dangle -- `_meta` is the ACP extension envelope.
  const defaultAuth = asRecord(initialized._meta)?.defaultAuthMethodId;
  let methodId = "login";
  if (runtime === "grok") {
    methodId = typeof defaultAuth === "string" ? defaultAuth : "cached_token";
  }
  await rpc("authenticate", { methodId });
  return { acp, rpc };
}

function reported(frame: JsonRecord): string {
  const option = asRecordList(frame.configOptions).find((entry) => entry.id === "model");
  const current = asRecord(frame.models)?.currentModelId;
  // oxlint-disable-next-line eslint/no-underscore-dangle -- `_meta` is the ACP extension envelope.
  const meta = asRecord(frame._meta)?.model;
  if ("error" in frame) {
    return `error ${JSON.stringify(frame.error)}`;
  }
  return `configOptions.model=${String(option?.currentValue)} models.currentModelId=${String(current)} _meta.model=${meta === undefined ? "undefined" : JSON.stringify(meta)}`;
}

/** The model-bearing notifications since `from`, each marked as arriving before or after the request's answer. */
function modelPushes(acp: JsonLinesChild, from: number): string {
  const frames = acp.seen.slice(from);
  const answeredAt = frames.findIndex((message) => message.method === undefined && message.id !== undefined);
  return frames
    .map((message, index) => ({ message, when: answeredAt === -1 || index < answeredAt ? "before answer" : "after answer" }))
    .filter(({ message }) => message.method !== undefined && /model/u.test(JSON.stringify(message.params)))
    .map(({ message, when }) => {
      const update = asRecord(asRecord(message.params)?.update);
      return `${String(message.method)}:${String(update?.sessionUpdate)} (${when}) ${reported(update ?? {})}`;
    })
    .join(" ; ") || "(none)";
}

async function probeAcp(runtime: "grok" | "kimi"): Promise<void> {
  const first = await acpOpen(runtime);
  const created = await first.rpc("session/new", { cwd: process.cwd(), mcpServers: [], ...(runtime === "grok" ? { _meta: { yoloMode: true } } : {}) });
  const sessionId = String(created.sessionId);
  const models = asRecordList(asRecord(created.models)?.availableModels).map((entry) => String(entry.modelId));
  const optionValues = asRecordList(asRecordList(created.configOptions).find((entry) => entry.id === "model")?.options).map((entry) => String(entry.value));
  const menu = models.length > 0 ? models : optionValues;
  console.log(`${runtime} session/new → ${reported(created)}; menu ${menu.join(", ")}`);
  const current = asRecord(created.models)?.currentModelId ?? asRecordList(created.configOptions).find((entry) => entry.id === "model")?.currentValue;
  const other = menu.find((entry) => entry !== current) ?? String(current);
  // Persist a model choice before the resume, so the resume can be asked to change it.
  const mark = first.acp.seen.length;
  const switched = await first.rpc("session/set_model", { sessionId, modelId: other });
  await delay(500);
  console.log(`${runtime} set_model ${other} → ${reported(switched)}; pushes ${modelPushes(first.acp, mark)}`);
  const bogusMark = first.acp.seen.length;
  const bogus = await first.rpc("session/set_model", { sessionId, modelId: "bogus-model-x" });
  await delay(500);
  console.log(`${runtime} set_model bogus-model-x → ${reported(bogus)}; pushes ${modelPushes(first.acp, bogusMark)}`);
  await first.rpc("session/close", { sessionId });
  await first.acp.stop();

  const second = await acpOpen(runtime);
  const resumeMethod = runtime === "grok" ? "session/load" : "session/resume";
  const resumeMark = second.acp.seen.length;
  const resumed = await second.rpc(resumeMethod, { sessionId, cwd: process.cwd(), mcpServers: [] });
  await delay(500);
  console.log(`${runtime} ${resumeMethod} → ${reported(resumed)}; pushes ${modelPushes(second.acp, resumeMark)}`);
  const backMark = second.acp.seen.length;
  const back = await second.rpc("session/set_model", { sessionId, modelId: String(current) });
  await delay(500);
  console.log(`${runtime} resume then set_model ${String(current)} → ${reported(back)}; pushes ${modelPushes(second.acp, backMark)}`);
  const badMark = second.acp.seen.length;
  const bad = await second.rpc("session/set_model", { sessionId, modelId: "bogus-model-x" });
  await delay(500);
  console.log(`${runtime} resume then set_model bogus-model-x → ${reported(bad)}; pushes ${modelPushes(second.acp, badMark)}`);
  await second.rpc("session/close", { sessionId });
  await second.acp.stop();
}

/** One grok prompt; the agent's reply text. */
async function grokTurn(open: Awaited<ReturnType<typeof acpOpen>>, sessionId: string, text = "Without using any tools: what are the project name and the project mascot? Answer in one short line."): Promise<string> {
  const mark = open.acp.seen.length;
  await open.rpc("session/prompt", { sessionId, prompt: [{ type: "text", text }] });
  return open.acp.seen.slice(mark)
    .map((message) => asRecord(asRecord(message.params)?.update))
    .filter((update) => update?.sessionUpdate === "agent_message_chunk")
    .map((update) => {
      const chunk = asRecord(update?.content)?.text;
      return typeof chunk === "string" ? chunk : "";
    })
    .join("")
    .trim();
}

// grok takes the system prompt on initialize (`_meta.systemPromptOverride`,
// `_meta.rules`); a real turn tells which one the loaded session runs.
async function probeGrokPrompt(): Promise<void> {
  // GROK_RULES_ONLY=1 sends `rules` without an override: grok folds rules
  // into its own template only when no override is given.
  const rulesOnly = process.env.GROK_RULES_ONLY === "1";
  const prompts = (base: string, rules: string): JsonRecord => ({
    ...(rulesOnly ? {} : { systemPromptOverride: `You are a helpful assistant for a software test. The project name is ${base}.` }),
    rules: `The project mascot is ${rules}. This is not recorded anywhere else.`,
  });
  const first = await acpOpen("grok", prompts("ALPHAPROJ", "GAMMAMASCOT"));
  const created = await first.rpc("session/new", { cwd: process.cwd(), mcpServers: [], _meta: { yoloMode: true } });
  const sessionId = String(created.sessionId);
  // The first turn must not name the project: an answer in the history
  // would leak into the loaded turn. It only makes the session a real one.
  console.log(`grok new ALPHA+GAMMA: ${await grokTurn(first, sessionId, process.env.GROK_ASK_FIRST === "1" ? undefined : "Reply with exactly ok.")}`);
  await first.rpc("session/close", { sessionId });
  await first.acp.stop();

  const second = await acpOpen("grok", prompts("BETAPROJ", "DELTAMASCOT"));
  await second.rpc("session/load", { sessionId, cwd: process.cwd(), mcpServers: [] });
  console.log(`grok load BETA+DELTA: ${await grokTurn(second, sessionId)}`);
  await second.rpc("session/close", { sessionId });
  await second.acp.stop();
}

if (which === "grok-prompt") {
  await probeGrokPrompt();
}
if (which === "claude" || which === "all") {
  await probeClaude();
}
if (which === "codex" || which === "all") {
  await probeCodex();
}
if (which === "acp" || which === "all") {
  await probeAcp("grok");
  await probeAcp("kimi");
}
