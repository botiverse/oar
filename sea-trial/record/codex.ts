import { startAppServerClient } from "../../packages/oar/src/runtimes/codex/app-server-client.js";
import { resolveExecutable } from "../../packages/oar/src/shared/executable/index.js";
import { asRecord } from "../../packages/oar/src/shared/json.js";
import type { RecordRequest } from "./claude.js";

/** Keep only the fields the codex projection reads (method + minimal params). */
function scrub(method: string, params: Record<string, unknown>): Record<string, unknown> | null {
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
    case "item/completed": {
      const item = asRecord(params.item);
      return { method, item: { type: item?.type, id: item?.id, command: item?.command, aggregatedOutput: item?.aggregatedOutput } };
    }
    case "error":
      return { method, error: { message: asRecord(params.error)?.message, additionalDetails: asRecord(params.error)?.additionalDetails } };
    default:
      return null;
  }
}

export async function startCodexRecording(request: RecordRequest): Promise<Record<string, unknown>[]> {
  const client = startAppServerClient(resolveExecutable("codex") ?? "codex", undefined, {
    sandbox_mode: '"danger-full-access"',
  });
  const raw: Record<string, unknown>[] = [];
  await client.request("initialize", { clientInfo: { name: "oar-record", version: "0" }, capabilities: { experimentalApi: true } });
  client.notify("initialized", {});
  const started = await client.request("thread/start", { cwd: process.cwd(), approvalPolicy: "never" });
  const threadId = asRecord(started.thread)?.id;
  if (typeof threadId !== "string") {
    throw new TypeError("codex thread/start returned no id");
  }
  let onTurnComplete: (() => void) | null = null;
  client.onNotification((method, params) => {
    if (params.threadId !== threadId) {
      return;
    }
    const scrubbed = scrub(method, params);
    if (scrubbed !== null) {
      raw.push(scrubbed);
    }
    if (method === "turn/completed") {
      onTurnComplete?.();
    }
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
  await runTurn(request.prompt);
  for (const followUp of request.followUps.filter((p) => !p.startsWith("+"))) {
    await runTurn(followUp);
  }
  return raw;
}
