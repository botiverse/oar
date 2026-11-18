import { randomUUID } from "node:crypto";
import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import type { Session } from "../../packages/oar/src/contracts/session.js";
import { resolveRunDir } from "./trace.js";

/** Save before asserting or disposing, independently of the optional shared trace. */
export async function retainTurnFailure(
  session: Pick<Session, "id" | "records">,
  outcome: unknown,
  context: Readonly<Record<string, string>>,
  directory = path.join(resolveRunDir(), "turn-failures"),
): Promise<string> {
  // Session records and the derived outcome already carry OAR's credential redaction.
  const frames = session.records().filter(record => record.kind === "frame").slice(-12).map(frame => {
    const json = JSON.stringify(frame);
    return { seq: frame.seq, type: frame.body.type, truncated: json.length > 16_384, json: json.slice(-16_384) };
  });
  await mkdir(directory, { recursive: true });
  const file = path.join(directory, `${randomUUID()}.json`);
  await writeFile(file, `${JSON.stringify({ sessionId: session.id, context, outcome, frames }, null, 2)}\n`);
  return file;
}
