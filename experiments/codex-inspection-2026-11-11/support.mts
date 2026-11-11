/* oxlint-disable eslint/no-await-in-loop -- Inspect only this probe's recorded processes, in order. */
import assert from "node:assert/strict";
import { mkdir, readFile } from "node:fs/promises";
import path from "node:path";
import { setTimeout } from "node:timers/promises";
import {
  asRecord,
  type JsonRecord,
} from "../../packages/oar/src/shared/json.js";

/** Explicit binaries and a new private output directory; no lookup of the user's default Codex. */
export async function prepareRun(): Promise<{
  readonly dir: string;
  readonly commands: readonly {
    readonly suffix: string;
    readonly version: string;
    readonly command: string;
  }[];
}> {
  assert.equal(
    process.platform,
    "linux",
    "This inspection reproducer has only been validated on Linux",
  );
  const [old, middle, current, output] = process.argv.slice(2);
  assert.ok(
    old !== undefined &&
      middle !== undefined &&
      current !== undefined &&
      output !== undefined,
    "usage: pnpm tsx <probe.mts> <codex-0.128.0> <codex-0.132.0> <codex-0.167.1> <new-output-directory>",
  );
  const dir = path.resolve(output);
  await mkdir(dir, { mode: 0o700 });
  return {
    dir,
    commands: [
      { suffix: "128", version: "0.128.0", command: path.resolve(old) },
      { suffix: "132", version: "0.132.0", command: path.resolve(middle) },
      { suffix: "167", version: "0.167.1", command: path.resolve(current) },
    ],
  };
}

/** The full wire stays private; selected results remove local roots, session/request UUIDs and PID lists. */
export function publicValue(value: unknown, roots: readonly string[]): unknown {
  return JSON.parse(
    JSON.stringify(value, (key: string, field: unknown): unknown => {
      if (key === "ownedPids") {
        return undefined;
      }
      if (typeof field !== "string") {
        return field;
      }
      let selected = field;
      for (const root of [...roots].toSorted(
        (left, right) => right.length - left.length,
      )) {
        selected = selected.replaceAll(root, "<isolated-root>");
      }
      return selected.replaceAll(
        /[\da-f]{8}(?:-[\da-f]{4}){3}-[\da-f]{12}/giu,
        "<synthetic-session-or-request-id>",
      );
    }),
  );
}

async function wireEvents(file: string): Promise<readonly JsonRecord[]> {
  const contents = await readFile(file, "utf8");
  return contents
    .trim()
    .split("\n")
    .map((line) => {
      const record = asRecord(JSON.parse(line));
      assert.ok(record !== null);
      return record;
    });
}

/** Read the binary's own initialize reply, never trust caller-supplied installation metadata. */
export async function verifyVersion(
  file: string,
  version: string,
  credential?: string,
): Promise<number> {
  const events = await wireEvents(file);
  const agents = events
    .map((event) => asRecord(asRecord(event.message)?.result)?.userAgent)
    .filter((value): value is string => typeof value === "string");
  assert.ok(agents.length > 0, "no native initialize result captured");
  assert.ok(
    agents.every((agent) => agent.startsWith(`oar/${version} `)),
    "wrong native binary supplied",
  );
  return credential === undefined
    ? 0
    : events.filter(
        (event) =>
          event.event === "response" &&
          JSON.stringify(asRecord(event.message)?.error ?? {}).includes(
            credential,
          ),
      ).length;
}

export async function verifyCleanup(file: string): Promise<{
  readonly processCount: number;
  readonly remaining: readonly number[];
}> {
  const events = await wireEvents(file);
  const pids = [
    ...new Set(
      events
        .filter((event) => event.event === "spawn")
        .flatMap((event) => [event.wrapperPid, event.nativePid]),
    ),
  ];
  await setTimeout(300);
  const remaining: number[] = [];
  for (const pid of pids) {
    assert.equal(typeof pid, "number");
    if (typeof pid !== "number") {
      throw new TypeError("wire PID is not numeric");
    }
    try {
      const stat = await readFile(`/proc/${pid}/stat`, "utf8");
      if (!/^.*\) Z /su.test(stat)) {
        remaining.push(pid);
      }
    } catch (error) {
      if (asRecord(error)?.code !== "ENOENT") {
        throw error;
      }
    }
  }
  assert.deepEqual(remaining, [], "owned probe process remains alive");
  return { processCount: pids.length, remaining };
}
