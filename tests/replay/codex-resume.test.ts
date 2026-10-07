import { readFileSync } from "node:fs";
import path from "node:path";
import { expect, test } from "vitest";
import type { Frame } from "../../packages/oar/src/contracts/session.js";
import { viewOf } from "../../packages/oar/src/observe/session-view.js";
import { usageOf } from "../../packages/oar/src/observe/usage.js";
import { foldCodexNotification, initialCodexProjection, type CodexProjectionState } from "../../packages/oar/src/runtimes/codex/projection.js";
import { asRecord, parseJson, type JsonRecord } from "../../packages/oar/src/shared/json.js";

/**
 * #169 from a recording: codex-cli 0.160.1 against the scripted provider
 * (`pnpm sea-trial:record codex-aimock resume first -- second`). "first" is
 * billed 1000 in / 5 out on a new thread; a new app-server process resumes
 * the thread and "second" is billed 1200 in / 7 out. A recorded open line
 * (`thread/start` / `thread/resume`) begins a Session, as the adapter opens
 * one, so each Session folds through its own projection.
 */

const ROOT = "thread-root";

interface Session {
  state: CodexProjectionState;
  readonly records: Frame[];
}

function frameRecords(session: Session, method: string, params: JsonRecord): void {
  const folded = foldCodexNotification(session.state, method, params);
  session.state = folded.state;
  for (const command of folded.commands) {
    if (command.kind === "frame") {
      const spanId = command.spanId === undefined ? {} : { spanId: command.spanId };
      session.records.push({ kind: "frame", sessionId: ROOT, agentPath: [], seq: session.records.length, receivedAt: 0, body: command.body, ...spanId });
    }
  }
}

/** The recorded fixture as each Session's frame records. */
function sessions(): Frame[][] {
  const opened: Session[] = [];
  const lines = readFileSync(path.join(import.meta.dirname, "fixtures", "codex-resume.raw.jsonl"), "utf8").split("\n").filter((line) => line.trim().length > 0);
  for (const line of lines) {
    const params = asRecord(parseJson(line)) ?? {};
    const method = String(params.method);
    const current = opened.at(-1);
    if (method === "thread/start" || method === "thread/resume") {
      opened.push({ state: initialCodexProjection(ROOT, method), records: [] });
    } else if (current !== undefined) {
      frameRecords(current, method, params);
    }
  }
  return opened.map((session) => session.records);
}

/** Each turn id the records saw start, named for the Session that started it. */
function turnNames(sessionsByName: Readonly<Record<string, readonly Frame[]>>): Map<string, string> {
  const names = new Map<string, string>();
  for (const [name, records] of Object.entries(sessionsByName)) {
    for (const record of records) {
      if (record.body.type === "turn/started" && record.spanId !== undefined) {
        names.set(record.spanId, `${name}'s turn`);
      }
    }
  }
  return names;
}

/** Each usage event as `turn: tokens in/out (cache read/write), context`, turns named by the Session that started them. */
function usageLines(records: readonly Frame[], turns: ReadonlyMap<string, string>): string[] {
  return records.flatMap((record) => record.body.events.flatMap((event) => {
    if (event.kind !== "usage") {
      return [];
    }
    const { tokens, context } = event.usage;
    const turn = turns.get(record.spanId ?? "") ?? "?";
    return [`${turn}: ${tokens?.input}/${tokens?.output} (${tokens?.cacheRead}/${tokens?.cacheWrite}), context ${context?.tokens}`];
  }));
}

test("codex resume: the total re-reported before the first turn is the Session's baseline", () => {
  const [opened = [], resumed = []] = sessions();
  const turns = turnNames({ opened, resumed });
  expect({ opened: usageLines(opened, turns), resumed: usageLines(resumed, turns) }).toMatchInlineSnapshot(`
    {
      "opened": [
        "opened's turn: 1000/5 (0/0), context 1005",
      ],
      "resumed": [
        "opened's turn: 0/0 (0/0), context 1005",
        "resumed's turn: 1200/7 (0/0), context 1207",
      ],
    }
  `);
  const own = { total: { input: 1200, output: 7, cacheRead: 0, cacheWrite: 0 } };
  expect([usageOf(opened).value, usageOf(resumed).value, viewOf(resumed).usage]).toEqual([
    { total: { input: 1000, output: 5, cacheRead: 0, cacheWrite: 0 } },
    own,
    own,
  ]);
});
