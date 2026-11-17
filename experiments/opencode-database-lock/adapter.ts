import assert from "node:assert/strict";
import { writeFile } from "node:fs/promises";
import path from "node:path";
import { opencodeSession } from "../../packages/oar/src/runtimes/opencode/session.js";
import type { Session } from "../../packages/oar/src/contracts/session.js";
import type { Observation } from "./observation.js";

/** Compare the actual adapter using the same native binary and WAL preparation. */
export async function adapterSample(input: { command: string; version: string; env: NodeJS.ProcessEnv; name: string; output: string }): Promise<Observation> {
  const { command, version, env, name, output } = input;
  const began = performance.now();
  const row: Observation = { name, adapter: true, initialized: false, opened: false, startedAt: new Date().toISOString(), elapsedMs: 0, exitCode: null, signal: null };
  const cwd = env.HOME; assert.ok(cwd !== undefined);
  const isolated: Record<string, string | null> = Object.fromEntries(Object.keys(process.env).map(key => [key, null]));
  for (const [key, value] of Object.entries(env)) { if (value !== undefined) { isolated[key] = value; } }
  let session: Session | undefined = undefined;
  try {
    session = await opencodeSession({ kind: "available", via: "executable", command, version }, { cwd, env: isolated });
    row.initialized = true; row.opened = true; row.version = version;
  } catch (error) { row.error = error instanceof Error ? error.message : String(error); }
  finally {
    row.elapsedMs = performance.now() - began;
    if (session !== undefined) {
      await session.dispose();
      const records = session.records();
      const exit = records.findLast(record => record.kind === "response" && record.body.kind === "exited");
      if (exit?.kind === "response" && exit.body.kind === "exited") { row.exitCode = exit.body.code; }
      row.cleanup = exit !== undefined;
      await writeFile(path.join(output, `${name}.records.json`), JSON.stringify(records, null, 2), { mode: 0o600 });
    }
    row.closedMs = performance.now() - began;
  }
  process.stdout.write(`${name}: ${row.opened ? "opened" : "FAILED"} ${String(Math.round(row.elapsedMs))}ms\n`);
  return row;
}
