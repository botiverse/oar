import { mkdtemp, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { startAppServerClient } from "../../packages/oar/src/runtimes/codex/app-server-client.js";
import { resolveExecutable } from "../../packages/oar/src/shared/executable/index.js";
import { asRecord } from "../../packages/oar/src/shared/json.js";
import { startCodexAimock, type LLMock } from "../harness/aimock.js";
import type { RecordRequest } from "./claude.js";

/** The item fields the codex projection reads, per item type. */
function scrubItem(item: Record<string, unknown> | null): Record<string, unknown> {
  if (item?.type === "fileChange") {
    return { type: item.type, id: item.id, changes: item.changes, status: item.status };
  }
  if (item?.type === "mcpToolCall") {
    return { type: item.type, id: item.id, server: item.server, tool: item.tool, status: item.status, arguments: item.arguments, result: item.result, error: item.error };
  }
  return { type: item?.type, id: item?.id, command: item?.command, aggregatedOutput: item?.aggregatedOutput };
}

/** Keep only the fields the codex projection reads (method + minimal params). */
export function scrub(method: string, params: Record<string, unknown>): Record<string, unknown> | null {
  switch (method) {
    case "turn/started":
      return { method, turn: { id: asRecord(params.turn)?.id } };
    case "turn/completed":
      return { method, turn: { status: asRecord(params.turn)?.status } };
    case "item/agentMessage/delta":
      return typeof params.delta === "string" ? { method, delta: params.delta } : null;
    case "rawResponseItem/completed":
      return { method, item: params.item };
    case "item/started":
    case "item/completed":
      return { method, item: scrubItem(asRecord(params.item)) };
    case "error":
      return { method, error: { message: asRecord(params.error)?.message, additionalDetails: asRecord(params.error)?.additionalDetails } };
    case "thread/tokenUsage/updated":
      return { method, turnId: params.turnId, tokenUsage: params.tokenUsage };
    default:
      return null;
  }
}

/** Where the recorded codex runs: its environment overlay and working directory. */
interface CodexTarget {
  readonly env?: Readonly<Record<string, string>>;
  readonly cwd: string;
}

/**
 * One app-server process on the thread: open it (a new thread, or a resume
 * of `resume`), run each prompt as a turn, exit. The open reply is recorded
 * as a line naming its method, where the adapter records the open frame, so
 * a replay knows where a Session begins and whether it resumed. Returns the
 * thread id.
 */
async function recordProcess(
  raw: Record<string, unknown>[],
  prompts: readonly string[],
  target: CodexTarget,
  resume?: string,
): Promise<string> {
  const { cwd } = target;
  const client = startAppServerClient(resolveExecutable("codex") ?? "codex", target.env, {
    sandbox_mode: '"danger-full-access"',
  }, cwd);
  await client.request("initialize", { clientInfo: { name: "oar-record", version: "0" }, capabilities: { experimentalApi: true } });
  client.notify("initialized", {});
  const method = resume === undefined ? "thread/start" : "thread/resume";
  const opened = await client.request(method, resume === undefined
    ? { cwd, approvalPolicy: "never" }
    : { threadId: resume, excludeTurns: true, cwd, approvalPolicy: "never" });
  const threadId = asRecord(opened.thread)?.id;
  if (typeof threadId !== "string") {
    throw new TypeError(`codex ${method} returned no id`);
  }
  raw.push({ method });
  let onTurnComplete: (() => void) | null = null;
  client.handle({
    onNotification: (notification, params) => {
      if (params.threadId !== threadId) {
        return;
      }
      const scrubbed = scrub(notification, params);
      if (scrubbed !== null) {
        raw.push(scrubbed);
      }
      if (notification === "turn/completed") {
        onTurnComplete?.();
      }
    },
    onServerRequest: () => {},
  });
  const runTurn = async (text: string): Promise<void> => {
    const settled = new Promise<void>((resolve) => {
      onTurnComplete = resolve;
    });
    await client.request("turn/start", { threadId, input: [{ type: "text", text }] });
    // Wait for the turn to actually finish (real codex is slower than a fixed
    // sleep), capped so a stuck turn does not hang the recorder.
    await Promise.race([settled, new Promise<void>((resolve) => {
      setTimeout(resolve, 30_000);
    })]);
  };
  for (const prompt of prompts) {
    await runTurn(prompt);
  }
  client.kill();
  await client.exited;
  return threadId;
}

/** Real codex, by default on the local login in the current directory. */
export async function startCodexRecording(
  request: RecordRequest,
  target?: CodexTarget,
): Promise<Record<string, unknown>[]> {
  const raw: Record<string, unknown>[] = [];
  const followUps = request.followUps.filter((p) => !p.startsWith("+"));
  await recordProcess(raw, [request.prompt, ...followUps], { ...target, cwd: target?.cwd ?? process.cwd() });
  return raw;
}

/**
 * One patch touching every change kind: an update, an add, a delete, and an
 * update that renames (`Move to`), in that order, so the recording shows
 * which order codex reports them in.
 */
const FILE_CHANGE_PATCH = [
  "*** Begin Patch",
  "*** Update File: notes.txt",
  "@@",
  "-old note",
  "+new note",
  "*** Add File: added.txt",
  "+fresh line",
  "*** Delete File: gone.txt",
  "*** Update File: old-name.txt",
  "*** Move to: new-name.txt",
  "@@",
  "-moved before",
  "+moved after",
  "*** End Patch",
].join("\n");

/**
 * The scripted model applies the patch, then answers. It goes through
 * `exec_command` as an `apply_patch` heredoc, which codex intercepts and
 * runs as a `fileChange` item (0.160.1): against aimock codex has no model
 * metadata, so it offers no `apply_patch` tool (a direct call answers
 * "unsupported call: apply_patch"), and aimock cannot send the freeform
 * custom tool call codex's own `apply_patch` takes.
 */
function fileChangeFixtures(mock: LLMock): void {
  const cmd = `apply_patch <<'EOF'\n${FILE_CHANGE_PATCH}\nEOF`;
  mock.on({ hasToolResult: false }, { toolCalls: [{ name: "exec_command", arguments: JSON.stringify({ cmd }) }] });
  mock.on({ hasToolResult: true }, { content: "patched" });
}

/** `text` as it appears inside a JSON string. */
function jsonEscaped(text: string): string {
  return JSON.stringify(text).slice(1, -1);
}

/** Every occurrence of `from` in the entry's strings replaced by `to`. */
function replaceText(entry: Record<string, unknown>, from: string, to: string): Record<string, unknown> {
  const json = JSON.stringify(entry).split(jsonEscaped(from)).join(jsonEscaped(to));
  return asRecord(JSON.parse(json)) ?? {};
}

/**
 * Real codex against the scripted provider (no login, no tokens), in a
 * scratch directory seeded with the files the patch changes. The scratch
 * path reads `<cwd>` in the recording, so it does not depend on the machine.
 */
export async function startCodexAimockRecording(request: RecordRequest): Promise<Record<string, unknown>[]> {
  const env = await startCodexAimock(fileChangeFixtures);
  const scratch = await mkdtemp(path.join(tmpdir(), "oar-record-"));
  const cwd = await realpath(scratch);
  try {
    await writeFile(path.join(cwd, "notes.txt"), "old note\n");
    await writeFile(path.join(cwd, "gone.txt"), "deleted\n");
    await writeFile(path.join(cwd, "old-name.txt"), "moved before\n");
    const raw = await startCodexRecording(request, { ...(env.env === undefined ? {} : { env: env.env }), cwd });
    return raw.map((entry) => replaceText(entry, cwd, "<cwd>"));
  } finally {
    await env.stop();
    await rm(cwd, { recursive: true, force: true });
  }
}

/**
 * The resume scenario on the scripted provider: the prompt runs on a new
 * thread, then each follow-up in a new app-server process that resumes it,
 * as a host reopening a Session does. The provider bills prompt `i` (by its
 * text) 1000 + 200i input and 5 + 2i output tokens, so each Session's own
 * spend differs from the thread's total codex reports (#169).
 */
export async function startCodexAimockResumeRecording(request: RecordRequest): Promise<Record<string, unknown>[]> {
  const prompts = [request.prompt, ...request.followUps];
  const env = await startCodexAimock((mock) => {
    prompts.forEach((prompt, index) => {
      mock.onMessage(prompt, { content: "pong", usage: { input_tokens: 1000 + 200 * index, output_tokens: 5 + 2 * index } });
    });
  });
  const scratch = await mkdtemp(path.join(tmpdir(), "oar-record-"));
  const cwd = await realpath(scratch);
  try {
    const target = { ...(env.env === undefined ? {} : { env: env.env }), cwd };
    const raw: Record<string, unknown>[] = [];
    const threadId = await recordProcess(raw, [request.prompt], target);
    for (const followUp of request.followUps) {
      await recordProcess(raw, [followUp], target, threadId);
    }
    return raw;
  } finally {
    await env.stop();
    await rm(cwd, { recursive: true, force: true });
  }
}
