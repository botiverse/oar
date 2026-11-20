import { constants, type Stats } from "node:fs";
import { open, readdir, lstat, rm, type FileHandle } from "node:fs/promises";
import { join } from "node:path";
import type { ModelRequest } from "../../contracts/model-request.js";
import { asRecord, type JsonRecord } from "../../shared/json.js";

function nativeFile(name: unknown, suffix: "request" | "response"): string | undefined {
  return typeof name === "string" && /^[\w-]+\.(?:request|response)\.json$/u.test(name) && name.endsWith(`.${suffix}.json`) ? name : undefined;
}

export interface AttributedRequest {
  readonly id: string;
  readonly indexedAt: number;
  readonly request?: string;
  readonly response: string;
  readonly model?: string;
}

export function attribution(row: JsonRecord): AttributedRequest | null {
  const response = nativeFile(row.response_file, "response");
  if (typeof row.message_id !== "string" || response === undefined) { return null; }
  const request = nativeFile(row.request_file, "request");
  if (row.request_file !== undefined && row.request_file !== null && request === undefined) { return null; }
  const indexedAt = typeof row.timestamp === "string" ? Date.parse(row.timestamp) : Number.NaN;
  return { id: row.message_id, indexedAt, response, ...(request === undefined ? {} : { request }), ...(typeof row.model === "string" ? { model: row.model } : {}) };
}

async function openFile(directory: string, name: string): Promise<{ file: FileHandle; info: Stats }> {
  const file = await open(join(directory, name), constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
  try {
    const info = await file.stat();
    if (!info.isFile()) { throw new Error("Claude's capture entry is not a regular file"); }
    return { file, info };
  } catch (error) { await file.close(); throw error; }
}

/** Read only the new, complete lines. A partial UTF-8 sequence stays on disk until its line ends. */
export async function readIndex(directory: string, offset: number): Promise<{ rows: JsonRecord[]; offset: number }> {
  const rows: JsonRecord[] = [];
  const { file, info } = await openFile(directory, "index.jsonl");
  try {
    if (info.size <= offset) { return { rows, offset }; }
    const data = Buffer.alloc(info.size - offset);
    const { bytesRead } = await file.read(data, 0, data.length, offset);
    const end = data.subarray(0, bytesRead).lastIndexOf(10) + 1;
    for (const line of data.toString("utf8", 0, end).split("\n")) {
      if (line.trim().length === 0) { continue; }
      const row = asRecord(JSON.parse(line));
      if (row !== null) { rows.push(row); }
    }
    return { rows, offset: offset + end };
  } finally { await file.close(); }
}

export async function readAttributed(directory: string, entry: AttributedRequest): Promise<ModelRequest> {
  const { file, info } = await openFile(directory, entry.request ?? entry.response);
  try {
    const body = asRecord(JSON.parse(await file.readFile("utf8")));
    if (body === null) { throw new Error("Incomplete Claude request capture"); }
    const model = typeof body.model === "string" ? body.model : entry.model;
    const meta = { at: info.mtime.toISOString(), format: "anthropic.messages", ...(model === undefined ? {} : { model }) };
    if (entry.request === undefined) { return { ...meta, withheld: ["not_captured"] }; }
    if ("not_recorded" in body) { return { ...meta, withheld: ["body"] }; }
    const thinking = Array.isArray(body.messages) && body.messages.some((message: unknown) => {
      const content = asRecord(message)?.content;
      return Array.isArray(content) && content.some((block: unknown) => asRecord(block)?.type === "thinking" && asRecord(block)?.thinking === "<REDACTED>");
    });
    return { ...meta, body, ...(thinking ? { withheld: ["thinking"] } : {}) };
  } finally { await file.close(); }
}

/** Only filenames the runtime named, plus older unclaimed attempts. Keep every in-flight request. */
export async function pruneCaptures(directory: string, retired: ReadonlySet<string>, keep: AttributedRequest | null): Promise<void> {
  const keptName = keep?.request ?? keep?.response;
  const kept = keptName === undefined ? undefined : await lstat(join(directory, keptName));
  const files = await readdir(directory);
  await Promise.all(files.map(async (name) => {
    if (name === keep?.request || name === keep?.response) { return; }
    if (nativeFile(name, "request") === undefined && nativeFile(name, "response") === undefined) { return; }
    const path = join(directory, name);
    const candidate = kept !== undefined && name.endsWith(".request.json") ? await lstat(path) : undefined;
    if (retired.has(name) || (candidate !== undefined && kept !== undefined && candidate.mtimeMs < kept.mtimeMs)) {
      await rm(path, { force: true });
    }
  }));
}
