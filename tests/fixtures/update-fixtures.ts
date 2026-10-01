import assert from "node:assert/strict";
import { once } from "node:events";
import { chmodSync, readFileSync, writeFileSync } from "node:fs";
import { createServer } from "node:http";
import path from "node:path";

/** A local stand-in for runtime release sources: each path answers a fixed status and body. */
export interface ReleaseServer {
  readonly base: string;
  readonly routes: Map<string, readonly [number, string]>;
  readonly close: () => void;
}

export async function startReleaseServer(): Promise<ReleaseServer> {
  const routes = new Map<string, readonly [number, string]>();
  const server = createServer((request, response) => {
    const [status, body] = routes.get(request.url ?? "") ?? [404, "not found"];
    response.writeHead(status).end(body);
  });
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  const address = server.address();
  assert.ok(address !== null && typeof address === "object");
  return { base: `http://127.0.0.1:${String(address.port)}`, routes, close: () => {
    server.close();
  } };
}

export interface PrintingExecutable {
  readonly dir: string;
  readonly name: string;
  /** One line of output, JSON without shell metacharacters. */
  readonly line: string;
  readonly exitCode?: number;
}

/** An executable that prints one line and exits, whatever its arguments. */
export function printingExecutable(spec: PrintingExecutable): string {
  const file = path.join(spec.dir, process.platform === "win32" ? `${spec.name}.cmd` : spec.name);
  const exitCode = String(spec.exitCode ?? 0);
  writeFileSync(file, process.platform === "win32"
    ? `@echo off\r\necho ${spec.line}\r\nexit /b ${exitCode}\r\n`
    : `#!/bin/sh\necho '${spec.line}'\nexit ${exitCode}\n`);
  chmodSync(file, 0o755);
  return file;
}

export interface FakeState {
  readonly version: string;
  readonly target: string;
  readonly mode: "upgrade" | "noop" | "fail" | "prompt" | "hang";
}

export interface FakeRuntime {
  readonly command: string;
  readonly read: () => Record<string, unknown>;
}

const fakeUpdater = path.join(import.meta.dirname, "fake-updater.mjs");

/** A runtime CLI with an updater (fake-updater.mjs), driven by a state file in `dir`. */
export function fakeRuntime(dir: string, name: string, state: FakeState): FakeRuntime {
  const stateFile = path.join(dir, `${name}.json`);
  writeFileSync(stateFile, JSON.stringify(state));
  const command = path.join(dir, process.platform === "win32" ? `${name}.cmd` : name);
  writeFileSync(command, process.platform === "win32"
    ? `@"${process.execPath}" "${fakeUpdater}" "${stateFile}" %*\r\n`
    : `#!/bin/sh\nexec "${process.execPath}" "${fakeUpdater}" "${stateFile}" "$@"\n`);
  chmodSync(command, 0o755);
  const read = (): Record<string, unknown> => {
    const parsed: unknown = JSON.parse(readFileSync(stateFile, "utf8"));
    assert.ok(typeof parsed === "object" && parsed !== null);
    return Object.fromEntries(Object.entries(parsed));
  };
  return { command, read };
}
