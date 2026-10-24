/* oxlint-disable import/max-dependencies -- A native probe composes isolated replay, MCP, process controls and saved-request evidence. */
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { readFile, readdir } from "node:fs/promises";
import path from "node:path";
import { serveMcpTools } from "../../packages/oar/src/mcp/serve-tools.js";
import { launchQoder, closeQoder } from "../../packages/oar/src/runtimes/qoder/launch.js";
import { qoderControl } from "../../packages/oar/src/runtimes/qoder/control.js";
import { asRecord, parseJson, type JsonRecord } from "../../packages/oar/src/shared/json.js";
import { startQoderNative } from "../../sea-trial/harness/qoder-native.js";

export type Priority = "now" | "next";
export type Phase = "streaming" | "tool";
export interface PriorityEvent {
  readonly type: string;
  readonly input?: string;
  readonly state?: unknown;
  readonly isError?: unknown;
  readonly terminalReason?: unknown;
  readonly injected?: boolean;
}
export interface CapturedRequest {
  readonly initial: boolean;
  readonly injected: boolean;
  readonly toolResult: boolean;
}
export interface PriorityReport {
  readonly priority: Priority;
  readonly phase: Phase;
  readonly capture: boolean;
  readonly events: readonly PriorityEvent[];
  readonly requests: readonly CapturedRequest[];
  readonly finalText: boolean;
}
async function within(promise: Promise<void>, what: string): Promise<void> {
  const limit = Promise.withResolvers<never>();
  const timer = setTimeout(() => { limit.reject(new Error(`Qoder priority probe did not reach ${what} within 20 seconds`)); }, 20_000);
  try { await Promise.race([promise, limit.promise]); } finally { clearTimeout(timer); }
}

/** The exhausted replay saves its actual model request; retain only synthetic-marker facts. */
async function capturedRequests(home: string, sessionId: string): Promise<readonly CapturedRequest[]> {
  const directory = path.join(home, ".qoder", "projects");
  const files = await readdir(directory, { recursive: true });
  const file = files.find((entry) => path.basename(entry) === `${sessionId}.jsonl`);
  assert.ok(file !== undefined, "No saved native conversation");
  const saved = await readFile(path.join(directory, file), "utf8");
  const records = saved.trim().split("\n").map((line) => asRecord(parseJson(line)));
  return records.flatMap((record) => {
    const error = record?.errorDetails;
    if (typeof error !== "string" || !error.includes("No more mock responses for generateContentStream")) { return []; }
    const request = asRecord(parseJson(error.split("got request:\n")[1]?.split("\n")[0] ?? ""));
    assert.ok(Array.isArray(request?.messages), "Exhausted replay did not preserve model messages");
    const input = JSON.stringify(request.messages);
    return [{ initial: input.includes("OAR_INITIAL_INPUT"), injected: input.includes("OAR_INJECTED_INPUT"), toolResult: input.includes("OAR_TOOL_RELEASED") }];
  });
}

export async function priorityScenario(priority: Priority, phase: Phase, capture: boolean): Promise<PriorityReport> {
  const toolEntered = Promise.withResolvers<void>(); const toolRelease = Promise.withResolvers<void>();
  const server = await serveMcpTools({ name: "gate", tools: [{ name: "hold", inputSchema: { type: "object", properties: {} },
    handler: async (): Promise<string> => { toolEntered.resolve(); await toolRelease.promise; return "OAR_TOOL_RELEASED"; } }] });
  const env = await startQoderNative([phase === "streaming" ? { chunks: Array.from({ length: 10 }, (_, index) => `chunk_${String(index)} `) }
    : { tool: { name: "mcp__gate__hold", args: {} } }, ...(capture ? [] : [{ text: "OAR_AFTER_INJECTION" }])], 300);
  const id = randomUUID(); const first = randomUUID(); const injected = randomUUID();
  const frames: JsonRecord[] = []; const events: PriorityEvent[] = [];
  const streaming = Promise.withResolvers<void>(); const accepted = Promise.withResolvers<void>();
  const initialEnded = Promise.withResolvers<void>(); const complete = Promise.withResolvers<void>();
  const terminal = new Set<string>();
  let child: Awaited<ReturnType<typeof launchQoder>> | undefined = undefined;
  function send(uuid: string, text: string, requestedPriority?: string): void {
    child?.write(`${JSON.stringify({ type: "user", uuid, session_id: id, ...(requestedPriority === undefined ? {} : { priority: requestedPriority }),
      message: { role: "user", content: [{ type: "text", text }] } })}\n`);
  }
  try {
    child = await launchQoder(process.env.OAR_QODER_BIN ?? "qodercli", id, { ...env.options, model: "efficient", mcpServers: [server.server] });
    const control = qoderControl(child, () => {}, 60_000);
    child.onLine((line) => {
      const frame = asRecord(parseJson(line)); if (frame === null || control.consume(frame)) { return; }
      frames.push(frame);
      if (frame.type === "stream_event" && asRecord(frame.event)?.type === "content_block_delta") { streaming.resolve(); }
      if (frame.type === "command_lifecycle") {
        const identities = new Map<string, string>([[first, "initial"], [injected, "injected"]]);
        const input = typeof frame.command_uuid === "string" ? identities.get(frame.command_uuid) ?? "other" : "other";
        events.push({ type: "lifecycle", input, state: frame.state });
        if (input === "injected" && frame.state === "queued") { accepted.resolve(); }
        if (frame.state === "completed" || frame.state === "cancelled") {
          terminal.add(input); if (input === "initial") { initialEnded.resolve(); }
          if (terminal.has("initial") && terminal.has("injected")) { complete.resolve(); }
        }
      }
      if (frame.type === "result") { events.push({ type: "result", isError: frame.is_error, terminalReason: frame.terminal_reason }); }
      if (frame.type === "user") { events.push({ type: "user", input: frame.uuid === injected ? "injected" : "other", injected: JSON.stringify(frame.message).includes("OAR_INJECTED_INPUT") }); }
    });
    child.onExit(control.end);
    await control.request({ subtype: "initialize" });
    send(first, "OAR_INITIAL_INPUT");
    await within(phase === "streaming" ? streaming.promise : toolEntered.promise, `${phase} boundary`);
    send(injected, "OAR_INJECTED_INPUT", priority);
    await within(accepted.promise, "injected input receipt");
    if (phase === "tool" && priority === "now") { await within(initialEnded.promise, "native interruption while tool remains blocked"); }
    if (phase === "tool") { events.push({ type: "tool_released" }); }
    toolRelease.resolve();
    await within(complete.promise, "both input lifecycles ending");
    await closeQoder(child); child = undefined;
    return { priority, phase, capture, events, requests: await capturedRequests(env.home, id),
      finalText: frames.some((frame) => frame.type === "assistant" && JSON.stringify(frame.message).includes("OAR_AFTER_INJECTION")) };
  } finally {
    toolRelease.resolve();
    if (child !== undefined) { await closeQoder(child); }
    await server.close(); await env.stop();
  }
}
