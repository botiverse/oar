import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import path from "node:path";
import { createInterface } from "node:readline";
import type { McpServer, Session } from "../../../packages/oar/src/contracts/session.js";
import type { ChatCompletionRequest } from "@copilotkit/aimock";
import type { LLMock, RawProviderRequest } from "../../harness/aimock.js";

/*
 * The echo MCP server (tests/fixtures/echo-mcp-server.mjs) seen from a vendor
 * test: entries for it, its HTTP form started on an ephemeral port, the
 * scripted model calling its tool, and what the provider received back.
 */

export const ECHO_SERVER = path.join(import.meta.dirname, "..", "..", "..", "tests", "fixtures", "echo-mcp-server.mjs");

/** The token the server reports: sha256's first 12 hex digits, as echo-mcp-server.mjs computes them. */
export function fingerprint(secret: string): string {
  return createHash("sha256").update(secret).digest("hex").slice(0, 12);
}

/** A stdio entry for the echo server, holding `token` as its env credential (none when absent); `flags` such as `--once` follow the script. */
export function stdioEcho(name: string, token?: string, flags: readonly string[] = []): McpServer {
  return { name, command: process.execPath, args: [ECHO_SERVER, ...flags], ...(token === undefined ? {} : { env: { OAR_ECHO_TOKEN: token } }) };
}

/** The echo server on streamable HTTP, until `stop`; `flags` such as `--once` follow `--http`. */
export async function startHttpEcho(flags: readonly string[] = []): Promise<{ readonly url: string; stop(): void }> {
  const child = spawn(process.execPath, [ECHO_SERVER, "--http", ...flags], { stdio: ["ignore", "pipe", "inherit"] });
  const lines = createInterface({ input: child.stdout });
  const url = await new Promise<string>((resolve, reject) => {
    lines.once("line", (line) => {
      resolve(line.replace(/^listening /u, ""));
    });
    child.once("exit", (code) => {
      reject(new Error(`the http echo server exited (${String(code)}) before listening`));
    });
  });
  return {
    url,
    stop: () => {
      child.kill();
    },
  };
}

/** One scripted echo call: the server whose tool the model calls, and the text it asks to echo. */
export interface EchoStep {
  readonly server: string;
  readonly text: string;
}

/**
 * How the model calls a server's `echo` tool on a runtime: the tool's name
 * and its arguments. claude, kimi and pi offer it as `mcp__<server>__echo`
 * (codex too, after the rewrite in raw-capture.ts).
 */
export type EchoCall = (server: string, text: string) => { readonly name: string; readonly arguments: Readonly<Record<string, unknown>> };

const mcpToolCall: EchoCall = (server, text) => ({ name: `mcp__${server}__echo`, arguments: { text } });

/**
 * A request whose current turn (the user messages after the last assistant
 * one) says `pattern`: aimock's `userMessage` reads the last user message
 * only, which kimi follows with a `<system-reminder>` of its own.
 */
export function currentTurnSays(pattern: RegExp): (request: ChatCompletionRequest) => boolean {
  return (request) => {
    const last = request.messages.findLastIndex((message) => message.role === "assistant");
    return request.messages.slice(last + 1).some((message) => message.role === "user" && pattern.test(JSON.stringify(message.content)));
  };
}

/** The model's call for a step, its id derived from the text so the next step can follow it. */
function call(step: EchoStep, shape: EchoCall): { name: string; arguments: string; id: string } {
  const { name, arguments: input } = shape(step.server, step.text);
  return { name, arguments: JSON.stringify(input), id: `call_${step.text}` };
}

/**
 * The scripted model calls `<server>`'s echo tool once per step, in order,
 * the runtime's way (`shape`, by default `mcp__<server>__echo`), each with
 * its own marker text and call id;
 * it answers once the last call's result comes back. Steps follow each other
 * by call id, not by result text: codex hands a tool's result back as
 * `input_text` parts, which aimock's `toolResultContains` cannot read. Whether
 * a call reached the server is `echoesReceived`'s to say.
 */
export function echoFixtures(mock: LLMock, prompt: RegExp, steps: readonly EchoStep[], shape: EchoCall = mcpToolCall): void {
  const [first, ...rest] = steps;
  if (first === undefined) {
    return;
  }
  mock.on({ predicate: currentTurnSays(prompt), hasToolResult: false }, { toolCalls: [call(first, shape)] });
  let previous = first;
  for (const step of rest) {
    mock.on({ hasToolResult: true, toolCallId: call(previous, shape).id }, { toolCalls: [call(step, shape)] });
    previous = step;
  }
  mock.on({ hasToolResult: true, toolCallId: call(previous, shape).id }, { content: "echoed" });
}

/** Every echo the provider received, in arrival order, each once: proof the runtime ran the server and handed its result to the model. */
export function echoesReceived(raw: readonly RawProviderRequest[]): readonly string[] {
  const echoes = raw.flatMap((request) => JSON.stringify(request.body).match(/echo:[\w-]+ via=\w+ token=\w+/gu) ?? []);
  return [...new Set(echoes)];
}

/*
 * The scenario every runtime's mcpServers vendor test runs: a stdio and an
 * http echo server, each with its own credential; the model calls both on
 * open, the stdio one again on a resume, and the stdio one on a name clash.
 */

export const STDIO_TOKEN = "oar-stdio-credential";
export const HTTP_AUTHORIZATION = "Bearer oar-http-credential";

/** Both secrets that appear in any record of the sessions: none may. */
export function leakedCredentials(...sessions: readonly Session[]): readonly string[] {
  const records = JSON.stringify(sessions.flatMap((session) => session.records()));
  return [STDIO_TOKEN, HTTP_AUTHORIZATION, "oar-http-credential"].filter((secret) => records.includes(secret));
}

/** The stdio echo server `echo` and the http one at `url`, `remote`; with no credentials when `credentials` is false. */
export function echoServers(url: string, credentials = true): readonly McpServer[] {
  return credentials
    ? [stdioEcho("echo", STDIO_TOKEN), { name: "remote", type: "http", url, headers: { Authorization: HTTP_AUTHORIZATION } }]
    : [stdioEcho("echo"), { name: "remote", type: "http", url }];
}

/** The three scripted conversations: both servers on open, the stdio one on resume, the stdio one on a clash. */
export function scriptEchoes(mock: LLMock, shape: EchoCall = mcpToolCall): void {
  echoFixtures(mock, /call both echo tools/u, [{ server: "echo", text: "stdio-call" }, { server: "remote", text: "http-call" }], shape);
  echoFixtures(mock, /call the echo tool again/u, [{ server: "echo", text: "resumed-call" }], shape);
  echoFixtures(mock, /call the clashing echo/u, [{ server: "echo", text: "clash-call" }], shape);
}

/** What the open and the resume each received: one echo per call, carrying the credential each server was given (`none` without). */
export function expectedEchoes(credentials = true): readonly string[] {
  const [stdio, http] = credentials ? [fingerprint(STDIO_TOKEN), fingerprint(HTTP_AUTHORIZATION)] : ["none", "none"];
  return [`echo:stdio-call via=stdio token=${stdio}`, `echo:http-call via=http token=${http}`, `echo:resumed-call via=stdio token=${stdio}`];
}

export const EXPECTED_ECHOES: readonly string[] = expectedEchoes();

/** The echo a clash call returns from the session's own server. */
export const CLASH_ECHO = `echo:clash-call via=stdio token=${fingerprint(STDIO_TOKEN)}`;
