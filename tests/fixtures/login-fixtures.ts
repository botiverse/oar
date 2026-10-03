import assert from "node:assert/strict";
import { chmodSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";

/** A fake vendor CLI (one of the fake-*-login.mjs scripts), driven by a JSON state file it also writes back to. */
export interface FakeCli {
  readonly command: string;
  /** The state file as the fake last wrote it. */
  readonly read: () => Record<string, unknown>;
}

export interface FakeCliSpec {
  readonly dir: string;
  readonly name: string;
  /** The fixture script beside this file. */
  readonly script: string;
  readonly state: Record<string, unknown>;
}

export function fakeLoginCli({ dir, name, script, state }: FakeCliSpec): FakeCli {
  const stateFile = path.join(dir, `${name}.json`);
  writeFileSync(stateFile, JSON.stringify(state));
  const fixture = path.join(import.meta.dirname, script);
  const command = path.join(dir, process.platform === "win32" ? `${name}.cmd` : name);
  writeFileSync(command, process.platform === "win32"
    ? `@"${process.execPath}" "${fixture}" "${stateFile}" %*\r\n`
    : `#!/bin/sh\nexec "${process.execPath}" "${fixture}" "${stateFile}" "$@"\n`);
  chmodSync(command, 0o755);
  const read = (): Record<string, unknown> => {
    const parsed: unknown = JSON.parse(readFileSync(stateFile, "utf8"));
    assert.ok(typeof parsed === "object" && parsed !== null);
    return Object.fromEntries(Object.entries(parsed));
  };
  return { command, read };
}

/** A pid the fake reported in its state; fails when it reported none. */
export function reportedPid(fake: FakeCli, key: string): number {
  const pid = fake.read()[key];
  assert.ok(typeof pid === "number", `the fake reported no ${key}`);
  return pid;
}
