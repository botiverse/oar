/**
 * agy 1.4.9: interactive delivery versus public stream-json input.
 * Linux/macOS with Python 3. Isolated homes, dummy Gemini provider, echo MCP.
 * OAR_AGY_BIN=/absolute/path/to/antigravity pnpm tsx experiments/agy-cli-steering.ts
 * Raw provider messages and terminal output stay in OAR_PROBE_DIR, not the repo.
 */
/* oxlint-disable eslint/no-await-in-loop -- Ordered, isolated probe scenarios. */
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { startAntigravityAimock } from "../sea-trial/harness/aimock-acp.js";
import { ECHO_SERVER } from "../sea-trial/vendor/support/echo-mcp.js";

type Mode = "queue" | "send-immediately" | "stream-json" | "control_request" | "control_response";
interface Observation {
  at: number;
  first: boolean;
  second: boolean;
  toolResult: boolean;
  firstAnswer: boolean;
  messages: unknown;
}
const binary = process.env.OAR_AGY_BIN;
assert.ok(binary !== undefined, "Set OAR_AGY_BIN to the installed agy binary");
const output = path.resolve(process.env.OAR_PROBE_DIR ?? "oar-trial-run/agy-cli-steering");
await mkdir(output, { recursive: true });
const firstMarker = "AGY_FIRST_INPUT_4241";
const secondMarker = "AGY_SECOND_INPUT_9563";

interface Summary {
  mode: Mode;
  secondSentAt: number | undefined;
  requestsBeforeRelease: number | undefined;
  requests: Omit<Observation, "messages">[];
}

function readResultIds(terminal: string): string[] {
  const resultIds: string[] = [];
  for (const line of terminal.trim().split("\n")) {
    const entry: unknown = JSON.parse(line);
    if (typeof entry === "object" && entry !== null && "event" in entry && entry.event === "result") {
      assert.ok("result" in entry && typeof entry.result === "object" && entry.result !== null);
      assert.ok("conversation_id" in entry.result && typeof entry.result.conversation_id === "string");
      resultIds.push(entry.result.conversation_id);
    }
  }
  return resultIds;
}

async function trial(command: string, mode: Mode, label: string): Promise<Summary> {
  const firstSeen = Promise.withResolvers<void>();
  const releaseFirst = Promise.withResolvers<void>();
  const finalSeen = Promise.withResolvers<void>();
  const secondSeen = Promise.withResolvers<void>();
  const requests: Observation[] = [];
  const started = Date.now();
  const time = (): number => Date.now() - started;
  const fixture = await startAntigravityAimock((mock) => {
    mock.on({ predicate: () => true }, async (request) => {
      const content = JSON.stringify(request.messages);
      // Title generation is a separate native request, not a conversation turn.
      if (content.includes("You are a conversation title generator")) {return { content: "Probe title" };}
      const first = content.includes(firstMarker);
      const second = content.includes(secondMarker);
      const toolResult = content.includes("echo:agy-tool-result");
      const firstAnswer = content.includes("AGY_FIRST_DONE");
      requests.push({ at: time(), first, second, toolResult, firstAnswer, messages: request.messages });
      if (second) { secondSeen.resolve(); return { content: "AGY_SECOND_DONE" }; }
      if (toolResult) {return { content: "AGY_FIRST_DONE" };}
      if (first) {
        firstSeen.resolve();
        await releaseFirst.promise;
        return { toolCalls: [{
          id: "agy_echo", name: "call_mcp_tool",
          arguments: JSON.stringify({ ServerName: "echo", ToolName: "echo", Arguments: { text: "agy-tool-result" } }),
        }] };
      }
      return { content: "AGY_UNEXPECTED_REQUEST" };
    });
  }, { mcpServers: { echo: { command: process.execPath, args: [ECHO_SERVER] } } });
  const home = fixture.env.HOME;
  assert.ok(home !== undefined);
  const settings = path.join(home, ".gemini", "antigravity-cli");
  await mkdir(settings, { recursive: true });
  await writeFile(path.join(settings, "settings.json"), JSON.stringify({
    modelProvider: "gemini", queuedMessages: mode === "queue" ? "queue" : "send-immediately",
    setupComplete: true, onboardingComplete: true, colorScheme: "dark", altScreenMode: "never",
  }));
  const inherited = Object.fromEntries(Object.entries(process.env)
    .filter(([key]) => ["PATH", "LANG", "LC_ALL", "TMPDIR", "SHELL", "SystemRoot"].includes(key)));
  const nativeLog = path.join(output, `${label}-native.log`);
  const args = ["--dangerously-skip-permissions", "--log-file", nativeLog];
  const interactive = mode === "queue" || mode === "send-immediately";
  const child = interactive
    ? spawn("python3", ["-u", path.join(import.meta.dirname, "agy-cli-steering", "terminal_bridge.py"), command, ...args, "-i", firstMarker], {
        cwd: home, env: { ...inherited, ...fixture.env, TERM: "xterm-256color", AGY_CLI_DISABLE_AUTO_UPDATE: "1", AGY_CLI_OSC7501: "off" },
      })
    : spawn(command, [...args, "--input-format", "stream-json", "--output-format", "stream-json"], {
        cwd: home, env: { ...inherited, ...fixture.env, AGY_CLI_DISABLE_AUTO_UPDATE: "1" },
      });
  let terminal = "";
  let trusted = false;
  let stderr = "";
  let expired = false;
  let spawnError: string | undefined = undefined;
  let secondSentAt: number | undefined = undefined;
  let requestsBeforeRelease: number | undefined = undefined;
  child.stdout.on("data", (data: Buffer) => {
    terminal += data.toString();
    // Consent applies only to this probe's temporary, isolated home.
    if (interactive && !trusted && terminal.includes("Do you trust the contents of this project?")) {
      trusted = true;
      child.stdin.write(`${JSON.stringify({ text: "\r" })}\n`);
    }
    if (terminal.includes("AGY_SECOND_DONE")) {finalSeen.resolve();}
  });
  child.stderr.on("data", (data: Buffer) => { stderr += data.toString(); });
  // Preserve early-exit evidence instead of an unhandled broken pipe.
  child.stdin.on("error", (error: Error) => { spawnError ??= error.message; });
  const exited = Promise.withResolvers<number | null>();
  const exit = exited.promise;
  child.once("error", (error) => {
    spawnError = error.message; firstSeen.resolve(); finalSeen.resolve(); secondSeen.resolve(); exited.resolve(null);
  });
  child.once("exit", (code) => { firstSeen.resolve(); finalSeen.resolve(); secondSeen.resolve(); exited.resolve(code); });
  const timer = setTimeout(() => {
    expired = true; firstSeen.resolve(); finalSeen.resolve(); secondSeen.resolve(); releaseFirst.resolve();
    child.stdin.end();
    if (!interactive) {child.kill();}
  }, 50_000);
  try {
    if (mode === "control_request" || mode === "control_response") {
      child.stdin.end(`${JSON.stringify({ event: mode, request_id: "probe", request: { subtype: "interrupt" } })}\n`);
      assert.equal(await exit, 2, "Unsupported control envelope must fail explicitly");
    } else {
      if (!interactive) {child.stdin.write(`${JSON.stringify({ event: "user", message: { content: firstMarker } })}\n`);}
      await firstSeen.promise;
      assert.equal(expired, false, "First inference did not arrive");
      assert.equal(spawnError, undefined);
      assert.equal(requests.length, 1);
      await delay(300);
      secondSentAt = time();
      child.stdin.write(`${JSON.stringify(interactive
        ? { text: `${secondMarker}\r` }
        : { event: "user", message: { content: secondMarker } })}\n`);
      await delay(700);
      requestsBeforeRelease = requests.length;
      releaseFirst.resolve();
      if (interactive) {
        // A TUI redraw may split a word across cursor movements. Provider
        // contents prove input delivery; raw terminal bytes are not a frame API.
        await secondSeen.promise;
        await delay(700);
      } else {
        await finalSeen.promise;
      }
      assert.equal(expired, false, "Second answer did not arrive");
      assert.equal(spawnError, undefined);
      assert.equal(requestsBeforeRelease, 1, "The held inference must not be interrupted");
      const secondRequest = requests.find((request) => request.second);
      assert.ok(secondRequest?.toolResult === true, "The real echo tool must have run");
      assert.equal(secondRequest.firstAnswer, mode !== "send-immediately");
      assert.equal(requests.length, mode === "send-immediately" ? 2 : 3);
      if (!interactive) {
        child.stdin.end();
        assert.equal(await exit, 0);
        const resultIds = readResultIds(terminal);
        assert.equal(resultIds.length, 2);
        assert.notEqual(resultIds[0], "");
        assert.equal(resultIds[0], resultIds[1]);
      }
    }
  } finally {
    clearTimeout(timer); releaseFirst.resolve(); child.stdin.end();
    if (!interactive) {child.kill();}
    await exit;
    const log = await readFile(nativeLog, "utf8").catch(() => "");
    await writeFile(path.join(output, `${label}.json`), JSON.stringify({
      mode, expired, secondSentAt, requestsBeforeRelease, requests, terminal, stderr,
      spawnError,
      forwardedMidTurn: log.includes("Forwarding mid-turn user message"),
      sendUserCascadeMessage: log.includes("SEND_USER_CASCADE_MESSAGE_LATENCY"),
    }, null, 2));
    await fixture.stop();
  }
  return { mode, secondSentAt, requestsBeforeRelease, requests: requests.map(({ messages: _messages, ...rest }) => rest) };
}

const summaries = [];
for (const [index, mode] of (["queue", "send-immediately", "send-immediately", "send-immediately", "stream-json", "control_request", "control_response"] as const).entries()) {
  const summary = await trial(binary, mode, `${index}-${mode}`);
  summaries.push(summary);
  console.log(JSON.stringify(summary));
}
await writeFile(path.join(output, "evidence.json"), JSON.stringify({ cliVersion: "1.4.9", summaries }, null, 2));
