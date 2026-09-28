/**
 * EFFORT CHANNELS: where each runtime takes a reasoning-effort level, what it
 * says back about the level it runs, and what a resume restores. The native
 * evidence behind SessionOptions.effort (docs/runtimes/<id>.md "Effort") and
 * the live-change survey (docs/runtimes/live-configure.md).
 *
 * Run: unset PI_PACKAGE_DIR && pnpm tsx experiments/effort-channels.ts [claude|codex|acp|pi|all]
 * Token-free: claude, grok, kimi and pi are asked without a model turn;
 * codex runs its turns against a local scripted provider (aimock) behind a
 * raw-body capture. `acp` probes grok and kimi (real logins, no prompt).
 *
 * ── OBSERVED 2026-09-29, darwin arm64: claude 2.1.284, codex-cli 0.155.1,
 *    grok 1.0.41, kimi 2.0.0, pi SDK 0.84.2 ──
 *
 * claude: get_settings `applied` (what "will actually be sent to the API"):
 * `--effort low` → effort low; `--effort bogus` → medium (stderr only:
 * "Unknown --effort value 'bogus' — ignoring it and using the default
 * effort"); `--model haiku --effort low` → effort null (the model takes
 * none); no flag → medium. The answer also carries `effective` and
 * `sources` (the merged settings, env included). Live on one process:
 * set_model opus → applied claude-opus-5-5, apply_flag_settings
 * {effortLevel: high} → high, set_model haiku → effort null; every answer a
 * bare `success`, unknown levels included.
 * codex (aimock): thread/start on gpt-5.5 with `config:
 * {model_reasoning_effort: low}` → reply reasoningEffort low, the turn sends
 * `reasoning.effort: low`. thread/resume without overrides answers the
 * thread's own gpt-5.5 / low; thread/settings/update {effort: high} answers
 * {} and pushes thread/settings/updated gpt-5.5 / high, and the next turn
 * runs gpt-5.5 / high. thread/resume WITH a config override answers the
 * config.toml model (gpt-5.1) instead, and that rebuild stays with the
 * thread: a plain resume afterwards, no turn in between, still answers
 * gpt-5.1 / high. An unknown level is echoed and forwarded as given.
 * grok: session/new configOptions `reasoning_effort` (category
 * thought_level) currentValue high; set_config_option low → answer low,
 * then `_x.ai/session_notification model_changed {reasoning_effort: low}`
 * and config_option_update; bogus → -32602 "unknown reasoning_effort
 * value"; `grok agent --reasoning-effort low stdio` still reports high;
 * a resume answers low (persisted, no prompt needed).
 * kimi: session/new `thinking` (category thought_level) high on k3;
 * set_config_option low → answer + config_option_update low; bogus →
 * -32602 "Invalid params: Unknown thinking value: bogus"; a resume answers
 * low.
 * pi: the listed menu is pi's getSupportedThinkingLevels per model
 * (gpt-6-astra minimal…max without off, gpt-6-luna off…max, deepseek-v4-flash
 * off/low/high/max); a session created with thinkingLevel low on a model
 * without reasoning (openrouter/ai21/jamba-large-1.7) runs `off`, clamped
 * without a word.
 */
/* oxlint-disable eslint/no-await-in-loop -- the probes run one process at a time, in order */
import { spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import { createInterface } from "node:readline";
import { setTimeout as delay } from "node:timers/promises";
import { piInstallation } from "../packages/oar/src/runtimes/pi/installation.js";
import { piListModels } from "../packages/oar/src/runtimes/pi/list-models.js";
import { asRecord, asRecordList, parseJson, type JsonRecord } from "../packages/oar/src/shared/json.js";
import { startCodexAimock } from "../sea-trial/harness/aimock.js";

const which = process.argv[2] ?? "all";

/** A JSON-lines child process: requests correlated by an id field, everything else collected. */
interface JsonLinesChild {
  send(message: JsonRecord): void;
  /** The next message the predicate accepts, or null after `ms`. */
  next(predicate: (message: JsonRecord) => boolean, ms?: number): Promise<JsonRecord | null>;
  readonly seen: JsonRecord[];
  stop(): Promise<void>;
}

function jsonLines(command: string, args: readonly string[], env: NodeJS.ProcessEnv = process.env): JsonLinesChild {
  const child = spawn(command, [...args], { env, stdio: ["pipe", "pipe", "ignore"] });
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

async function claudeApplied(claude: JsonLinesChild): Promise<unknown> {
  const answer = await claudeControl(claude, { subtype: "get_settings" });
  return asRecord(asRecord(answer?.response)?.applied);
}

function claudeProcess(args: readonly string[]): JsonLinesChild {
  return jsonLines("claude", [
    "-p", "--input-format", "stream-json", "--output-format", "stream-json", "--verbose",
    "--dangerously-skip-permissions", "--session-id", randomUUID(), ...args,
  ], { ...process.env, CLAUDECODE: undefined });
}

async function probeClaude(): Promise<void> {
  for (const args of [["--effort", "low"], ["--effort", "bogus"], ["--model", "haiku", "--effort", "low"], []]) {
    const claude = claudeProcess(args);
    console.log(`claude ${args.join(" ") || "(no flags)"} → applied ${JSON.stringify(await claudeApplied(claude))}`);
    await claude.stop();
  }
  const live = claudeProcess(["--model", "sonnet", "--effort", "low"]);
  console.log(`claude live: at open ${JSON.stringify(await claudeApplied(live))}`);
  for (const request of [
    { subtype: "set_model", model: "opus" },
    { subtype: "apply_flag_settings", settings: { effortLevel: "high" } },
    { subtype: "apply_flag_settings", settings: { effortLevel: "bogus" } },
    { subtype: "set_model", model: "haiku" },
  ]) {
    const answer = await claudeControl(live, request);
    console.log(`claude live: ${JSON.stringify(request)} → ${String(answer?.subtype)}, applied ${JSON.stringify(await claudeApplied(live))}`);
  }
  await live.stop();
}

// ─── codex (scripted provider) ─────────────────────────────────────────────

function threadIdOf(reply: JsonRecord): string {
  const id = asRecord(reply.thread)?.id;
  return typeof id === "string" ? id : "";
}

async function probeCodex(): Promise<void> {
  const env = await startCodexAimock(undefined, { captureRaw: true });
  let rpcId = 0;
  const rpc = async (codex: JsonLinesChild, method: string, params: JsonRecord): Promise<JsonRecord> => {
    rpcId += 1;
    const id = rpcId;
    const answered = codex.next((message) => message.id === id && message.method === undefined, 60_000);
    codex.send({ id, method, params });
    const answer = await answered;
    return asRecord(answer?.result) ?? { error: answer?.error ?? "no answer" };
  };
  const open = async (): Promise<JsonLinesChild> => {
    const codex = jsonLines("codex", ["app-server", "-c", 'sandbox_mode="danger-full-access"', "--listen", "stdio://"], { ...process.env, ...env.env });
    await rpc(codex, "initialize", { clientInfo: { name: "oar-probe", version: "0.0.0" }, capabilities: { experimentalApi: true } });
    return codex;
  };
  const turn = async (codex: JsonLinesChild, threadId: string, text: string): Promise<string> => {
    const before = env.raw.length;
    const done = codex.next((message) => message.method === "turn/completed", 60_000);
    await rpc(codex, "turn/start", { threadId, input: [{ type: "text", text }] });
    await done;
    const sent = env.raw.slice(before).map((request) => asRecord(request.body)).filter((body) => asRecord(body?.reasoning) !== null);
    return sent.map((body) => `${String(body?.model)}/${String(asRecord(body?.reasoning)?.effort)}`).join(", ");
  };
  const newThread = async (): Promise<string> => {
    const codex = await open();
    const started = await rpc(codex, "thread/start", { cwd: process.cwd(), approvalPolicy: "never", model: "gpt-5.5", config: { model_reasoning_effort: "low" } });
    const threadId = threadIdOf(started);
    console.log(`codex thread/start gpt-5.5 + config low → model ${String(started.model)} reasoningEffort ${String(started.reasoningEffort)}; wire ${await turn(codex, threadId, "one")}`);
    await codex.stop();
    return threadId;
  };
  const resume = async (threadId: string, label: string, params: JsonRecord = {}): Promise<JsonLinesChild> => {
    const codex = await open();
    const resumed = await rpc(codex, "thread/resume", { threadId, excludeTurns: true, cwd: process.cwd(), approvalPolicy: "never", ...params });
    console.log(`codex thread/resume ${label} → model ${String(resumed.model)} reasoningEffort ${String(resumed.reasoningEffort)}`);
    return codex;
  };
  try {
    // A resume without overrides keeps the thread's model and level; the
    // level then changes on the loaded thread.
    const kept = await newThread();
    let codex = await resume(kept, "without overrides");
    const updated = codex.next((message) => message.method === "thread/settings/updated");
    const reply = await rpc(codex, "thread/settings/update", { threadId: kept, effort: "high" });
    const pushed = await updated;
    const settings = asRecord(asRecord(pushed?.params)?.threadSettings);
    console.log(`codex thread/settings/update high → ${JSON.stringify(reply)}, pushed model ${String(settings?.model)} effort ${String(settings?.effort)}; wire ${await turn(codex, kept, "two")}`);
    await codex.stop();

    // A config override on resume rebuilds the thread from config.toml
    // (gpt-5.1 there), and the rebuilt settings stay with the thread.
    const rebuilt = await newThread();
    codex = await resume(rebuilt, "with config {model_reasoning_effort: high}", { config: { model_reasoning_effort: "high" } });
    await codex.stop();
    codex = await resume(rebuilt, "again, without overrides, no turn in between");
    await codex.stop();

    codex = await open();
    const unknown = await rpc(codex, "thread/start", { cwd: process.cwd(), approvalPolicy: "never", config: { model_reasoning_effort: "oar-no-such-effort" } });
    console.log(`codex unknown level → reasoningEffort ${String(unknown.reasoningEffort)}; wire ${await turn(codex, threadIdOf(unknown), "three")}`);
    await codex.stop();
  } finally {
    await env.stop();
  }
}

// ─── ACP: grok, kimi ───────────────────────────────────────────────────────

function thoughtLevel(options: unknown): string {
  const option = asRecordList(options).find((entry) => entry.category === "thought_level");
  return option === undefined ? "(no thought_level option)" : `${String(option.id)}=${String(option.currentValue)}`;
}

async function acpOpen(runtime: "grok" | "kimi", extraArgs: readonly string[] = []): Promise<{ acp: JsonLinesChild; rpc: (method: string, params: JsonRecord) => Promise<JsonRecord> }> {
  const args = runtime === "grok" ? ["agent", "--always-approve", "--no-leader", ...extraArgs, "stdio"] : ["acp"];
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
    ...(runtime === "grok" ? { _meta: { clientIdentifier: "oar", clientType: "generic", startupHints: { nonInteractive: true, skipGitStatus: true, skipProjectLayout: true } } } : {}),
  });
  // oxlint-disable-next-line eslint/no-underscore-dangle -- `_meta` is the ACP extension envelope.
  const defaultAuth = asRecord(initialized._meta)?.defaultAuthMethodId;
  const grokAuth = typeof defaultAuth === "string" ? defaultAuth : "cached_token";
  await rpc("authenticate", { methodId: runtime === "grok" ? grokAuth : "login" });
  return { acp, rpc };
}

async function probeAcp(runtime: "grok" | "kimi"): Promise<void> {
  const first = await acpOpen(runtime);
  const created = await first.rpc("session/new", { cwd: process.cwd(), mcpServers: [], ...(runtime === "grok" ? { _meta: { yoloMode: true } } : {}) });
  const sessionId = String(created.sessionId);
  const option = asRecordList(created.configOptions).find((entry) => entry.category === "thought_level");
  console.log(`${runtime} session/new → ${thoughtLevel(created.configOptions)}`);
  for (const value of ["low", "bogus"]) {
    const answer = await first.rpc("session/set_config_option", { sessionId, configId: String(option?.id), value });
    console.log(`${runtime} set_config_option ${value} → ${"error" in answer ? JSON.stringify(answer.error) : thoughtLevel(answer.configOptions)}`);
  }
  await delay(500);
  const pushes = first.acp.seen.filter((message) => typeof message.method === "string" && /model_changed|config_option_update/u.test(JSON.stringify(message.params)));
  const described = pushes.map((message) => {
    const update = asRecord(asRecord(message.params)?.update);
    const effort = update?.reasoning_effort ?? thoughtLevel(update?.configOptions);
    return `${String(message.method)} ${JSON.stringify(effort)}`;
  });
  console.log(`${runtime} pushes: ${described.join("; ")}`);
  await first.rpc("session/close", { sessionId });
  await first.acp.stop();

  const second = await acpOpen(runtime);
  const resumed = await second.rpc("session/resume", { sessionId, cwd: process.cwd(), mcpServers: [] });
  console.log(`${runtime} session/resume (no prompt) → ${thoughtLevel(resumed.configOptions)}`);
  await second.rpc("session/close", { sessionId });
  await second.acp.stop();

  if (runtime === "grok") {
    const flagged = await acpOpen("grok", ["--reasoning-effort", "low"]);
    const answer = await flagged.rpc("session/new", { cwd: process.cwd(), mcpServers: [], _meta: { yoloMode: true } });
    console.log(`grok agent --reasoning-effort low stdio: session/new → ${thoughtLevel(answer.configOptions)}`);
    await flagged.rpc("session/close", { sessionId: String(answer.sessionId) });
    await flagged.acp.stop();
  }
}

// ─── pi ────────────────────────────────────────────────────────────────────

async function probePi(): Promise<void> {
  // The menu as oar lists it, which is pi's own getSupportedThinkingLevels per model.
  const installation = await piInstallation();
  const listed = installation.kind === "available" ? await piListModels(installation) : null;
  for (const model of listed?.kind === "ok" ? listed.models.slice(0, 40) : []) {
    console.log(`pi ${model.id} levels=${model.effortLevels?.join(",") ?? "(none)"}`);
  }
  const sdk = await import("@earendil-works/pi-coding-agent");
  const agentDir = process.env.OAR_PI_AGENT_DIR ?? sdk.getAgentDir();
  const settingsManager = sdk.SettingsManager.create(process.cwd(), agentDir);
  const services = await sdk.createAgentSessionServices({
    cwd: process.cwd(),
    agentDir,
    settingsManager,
    resourceLoaderOptions: { noSkills: true, noPromptTemplates: true, noThemes: true, noContextFiles: true },
  });
  const available = await services.modelRuntime.getAvailable();
  const plain = available.find((model) => !model.reasoning);
  if (plain !== undefined) {
    // No prompt: pi writes the session file on the first message only.
    const { session } = await sdk.createAgentSessionFromServices({
      services,
      sessionManager: sdk.SessionManager.inMemory(process.cwd()),
      model: plain,
      thinkingLevel: "low",
    });
    console.log(`pi thinkingLevel low on ${plain.provider}/${plain.id} → runs ${session.thinkingLevel}`);
    session.dispose();
  }
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
if (which === "pi" || which === "all") {
  await probePi();
}
