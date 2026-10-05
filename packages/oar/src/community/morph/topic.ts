import type { ResponseBody } from "../../contracts/session.js";
import { asRecord, asRecordList } from "../../shared/json.js";
import { replyMessage, type ConsoleClient, type ConsoleReply } from "./console.js";

/** A submission morph did not take: its answer, and whether it was a refusal (400) rather than a failure. */
export class MorphRefusalError extends Error {
  override readonly name = "MorphRefusalError";
  readonly native: unknown;
  readonly refused: boolean;

  constructor(reply: ConsoleReply) {
    super(replyMessage(reply));
    this.native = reply.body;
    this.refused = reply.status === 400;
  }
}

/** The topic a session runs in: the one to resume, checked to exist, or a new empty one (`POST /topics`). */
export async function openTopic(client: ConsoleClient, resume: string | undefined): Promise<string> {
  if (resume !== undefined) {
    const reply = await client.call("GET", `/topics/${encodeURIComponent(resume)}`);
    if (reply.status === 404) {
      throw new Error(`morph has no topic ${resume} to resume`);
    }
    if (reply.status !== 200) {
      throw new Error(`morph GET /topics/${resume} answered ${String(reply.status)}: ${replyMessage(reply)}`);
    }
    return resume;
  }
  const reply = await client.call("POST", "/topics", {});
  if (reply.status === 405) {
    throw new Error("This morph Console cannot create an empty topic (POST /topics); update morph to a version that has it");
  }
  if (reply.status !== 201 && reply.status !== 200) {
    throw new Error(`morph POST /topics answered ${String(reply.status)}: ${replyMessage(reply)}`);
  }
  const id = asRecord(reply.body)?.id;
  if (typeof id !== "string" || id === "") {
    throw new Error("morph POST /topics answered without a topic id");
  }
  return id;
}

/** Refuse to open on an LLM profile Console does not have, rather than fail the first turn. */
export async function checkProfile(client: ConsoleClient, model: string): Promise<void> {
  const catalog = asRecord(await client.expect("GET", "/llm/profiles"));
  const names = [asRecord(catalog?.default), ...asRecordList(catalog?.items)]
    .map((profile) => profile?.name)
    .filter((name): name is string => typeof name === "string");
  if (!names.includes(model)) {
    throw new Error(`morph has no LLM profile ${model} (configured: ${names.join(", ")})`);
  }
}

/** `POST /tasks` into the topic; a non-200 answer or one without a task id is a `MorphRefusalError`. */
export async function submitTask(client: ConsoleClient, body: Readonly<Record<string, unknown>>): Promise<Record<string, unknown> & { readonly id: string }> {
  const reply = await client.call("POST", "/tasks", body);
  const answer = asRecord(reply.body);
  const id = answer?.id;
  if (reply.status !== 200 || answer === null || typeof id !== "string") {
    throw new MorphRefusalError(reply);
  }
  return { ...answer, id };
}

/** `POST /tasks/{id}/stop`: accepted when Console found running work for the task. */
export async function stopTask(client: ConsoleClient, taskId: string): Promise<ResponseBody> {
  const reply = await client.call("POST", `/tasks/${encodeURIComponent(taskId)}/stop`);
  if (reply.status !== 200) {
    return { kind: "rejected", code: "runtime_refused", reason: replyMessage(reply), native: reply.body };
  }
  return asRecord(reply.body)?.found === true
    ? { kind: "accepted", native: reply.body }
    : { kind: "rejected", code: "no_active_turn", reason: "morph found no running work for the task", native: reply.body };
}

/** The task whose turn carries a submission: the run it steered into, or its own. */
export function carrierTask(answer: Readonly<Record<string, unknown>> & { readonly id: string }): string {
  const target = answer.steer_target_task_id;
  return typeof target === "string" && target !== "" ? target : answer.id;
}
