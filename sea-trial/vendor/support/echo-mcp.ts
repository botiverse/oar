import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import path from "node:path";
import { createInterface } from "node:readline";
import type { McpServer } from "../../../packages/oar/src/contracts/session.js";
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

/** A stdio entry for the echo server, holding `token` as its env credential. */
export function stdioEcho(name: string, token: string): McpServer {
  return { name, command: process.execPath, args: [ECHO_SERVER], env: { OAR_ECHO_TOKEN: token } };
}

/** The echo server on streamable HTTP, until `stop`. */
export async function startHttpEcho(): Promise<{ readonly url: string; stop(): void }> {
  const child = spawn(process.execPath, [ECHO_SERVER, "--http"], { stdio: ["ignore", "pipe", "inherit"] });
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

/** The model's call for a step, its id derived from the text so the next step can follow it. */
function call(step: EchoStep): { name: string; arguments: string; id: string } {
  return { name: `mcp__${step.server}__echo`, arguments: JSON.stringify({ text: step.text }), id: `call_${step.text}` };
}

/**
 * The scripted model calls `<server>`'s echo tool once per step, in order, by
 * claude's tool naming (`mcp__<server>__echo`; for codex the rewrite in
 * raw-capture.ts namespaces it), each with its own marker text and call id;
 * it answers once the last call's result comes back. Steps follow each other
 * by call id, not by result text: codex hands a tool's result back as
 * `input_text` parts, which aimock's `toolResultContains` cannot read. Whether
 * a call reached the server is `echoesReceived`'s to say.
 */
export function echoFixtures(mock: LLMock, prompt: RegExp, steps: readonly EchoStep[]): void {
  const [first, ...rest] = steps;
  if (first === undefined) {
    return;
  }
  mock.on({ userMessage: prompt, hasToolResult: false }, { toolCalls: [call(first)] });
  let previous = first;
  for (const step of rest) {
    mock.on({ hasToolResult: true, toolCallId: call(previous).id }, { toolCalls: [call(step)] });
    previous = step;
  }
  mock.on({ hasToolResult: true, toolCallId: call(previous).id }, { content: "echoed" });
}

/** Every echo the provider received, in arrival order, each once: proof the runtime ran the server and handed its result to the model. */
export function echoesReceived(raw: readonly RawProviderRequest[]): readonly string[] {
  const echoes = raw.flatMap((request) => JSON.stringify(request.body).match(/echo:[\w-]+ via=\w+ token=\w+/gu) ?? []);
  return [...new Set(echoes)];
}
