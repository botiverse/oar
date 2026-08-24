import { randomUUID } from "node:crypto";
import { constants } from "node:fs";
import { access, chmod, mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { delimiter, isAbsolute, join } from "node:path";
import { SAY_ENV_NAME } from "./say-protocol.js";

const MAX_SAY_BYTES = 1024 * 1024;
const POLL_INTERVAL_MS = 10;
const REQUEST_SUFFIX = ".request";
const ACK_SUFFIX = ".ack";

export interface SayBridge {
  /** Absolute host-side locator; agents receive it indirectly through OAR_SAY. */
  readonly command: string;
  readonly env: Readonly<Record<string, string>>;
  dispose(): Promise<void>;
}

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : "Unknown say bridge error";
}

function textFromBody(body: string, token: string): string {
  if (Buffer.byteLength(body, "utf8") > MAX_SAY_BYTES) {
    throw new Error("say payload is too large");
  }
  let parsed: unknown = null;
  try {
    parsed = JSON.parse(body);
  } catch {
    throw new Error("say payload must be JSON");
  }
  if (typeof parsed !== "object" || parsed === null) {
    throw new Error("say payload must be an object");
  }
  if (!("token" in parsed) || parsed.token !== token) {
    throw new Error("say payload is unauthorized");
  }
  if (!("text" in parsed) || typeof parsed.text !== "string" || parsed.text.trim().length === 0) {
    throw new Error("say text must be a non-empty string");
  }
  return parsed.text.trim();
}

async function deliverRequest(
  directory: string,
  filename: string,
  token: string,
  onSay: (text: string) => void,
): Promise<void> {
  const requestPath = join(directory, filename);
  const acknowledgementPath = join(directory, `${filename.slice(0, -REQUEST_SUFFIX.length)}${ACK_SUFFIX}`);
  let acknowledgement = "";
  try {
    onSay(textFromBody(await readFile(requestPath, "utf8"), token));
  } catch (error) {
    acknowledgement = messageOf(error);
  }
  await writeFile(acknowledgementPath, acknowledgement, { mode: 0o600 });
  await rm(requestPath, { force: true });
}

function shellQuote(value: string): string {
  return `'${value.replaceAll("'", `'"'"'`)}'`;
}

async function nodeExecutable(): Promise<string | null> {
  const pathKey = Object.keys(process.env).find((key) => key.toLowerCase() === "path") ?? "PATH";
  const executableName = process.platform === "win32" ? "node.exe" : "node";
  const configured = [process.env.npm_node_execpath, process.env.NODE]
    .filter((candidate): candidate is string => candidate !== undefined && isAbsolute(candidate));
  const fromPath = (process.env[pathKey] ?? "")
    .split(delimiter)
    .filter((directory) => directory.length > 0)
    .map((directory) => join(directory, executableName));
  for (const candidate of [...configured, ...fromPath]) {
    try {
      await access(candidate, constants.X_OK);
      return candidate;
    } catch {
      // Keep looking. Packaged apps commonly have no standalone Node binary.
    }
  }
  return null;
}

function sayClientSource(directory: string, token: string): string {
  return `"use strict";
const { randomUUID } = require("node:crypto");
const { existsSync, readFileSync, renameSync, rmSync, writeFileSync } = require("node:fs");
const { join } = require("node:path");

function stdinText() {
  return new Promise((resolve, reject) => {
    let body = "";
    process.stdin.setEncoding("utf8");
    process.stdin.on("data", (chunk) => { body += chunk; });
    process.stdin.once("end", () => resolve(body));
    process.stdin.once("error", reject);
  });
}

(async () => {
  const argumentText = process.argv.slice(2).join(" ");
  const text = (argumentText.length > 0 ? argumentText : await stdinText()).trim();
  if (text.length === 0) {
    process.stderr.write("usage: say <message> (or pipe a message on stdin)\\n");
    process.exitCode = 2;
    return;
  }
  const payload = JSON.stringify({ text, token: ${JSON.stringify(token)} });
  if (Buffer.byteLength(payload, "utf8") > ${String(MAX_SAY_BYTES)}) {
    throw new Error("say payload is too large");
  }
  const id = [String(Date.now()), String(process.pid), randomUUID()].join("-");
  const temporaryPath = join(${JSON.stringify(directory)}, id + ".tmp");
  const requestPath = join(${JSON.stringify(directory)}, id + ${JSON.stringify(REQUEST_SUFFIX)});
  const acknowledgementPath = join(${JSON.stringify(directory)}, id + ${JSON.stringify(ACK_SUFFIX)});
  writeFileSync(temporaryPath, payload, { mode: 0o600 });
  renameSync(temporaryPath, requestPath);
  const deadline = Date.now() + 10_000;
  while (!existsSync(acknowledgementPath)) {
    if (Date.now() >= deadline) {
      rmSync(requestPath, { force: true });
      throw new Error("say bridge timed out");
    }
    await new Promise((resolve) => { setTimeout(resolve, ${String(POLL_INTERVAL_MS)}); });
  }
  const error = readFileSync(acknowledgementPath, "utf8");
  rmSync(acknowledgementPath, { force: true });
  if (error.length > 0) {
    throw new Error(error);
  }
})().catch((error) => {
  process.stderr.write(String(error) + "\\n");
  process.exitCode = 1;
});
`;
}

export async function createSayBridge(onSay: (text: string) => void): Promise<SayBridge> {
  const token = randomUUID();
  const directory = await mkdtemp(join(tmpdir(), "coxswain-say-"));
  const standaloneNode = await nodeExecutable();
  const clientRuntime = standaloneNode ?? process.execPath;
  const needsElectronNodeMode = standaloneNode === null;
  let disposed = false;
  let scanInFlight: Promise<void> | null = null;
  const scan = (): void => {
    if (disposed || scanInFlight !== null) {
      return;
    }
    scanInFlight = (async (): Promise<void> => {
      const entries = await readdir(directory);
      for (const entry of entries.filter((name) => name.endsWith(REQUEST_SUFFIX)).toSorted()) {
        await deliverRequest(directory, entry, token, onSay);
      }
    })().finally(() => {
      scanInFlight = null;
    });
    void scanInFlight.catch(() => null);
  };
  const awaitScan = async (): Promise<void> => {
    const pending = scanInFlight;
    if (pending !== null) {
      await pending;
    }
  };
  const poller = setInterval(scan, POLL_INTERVAL_MS);
  poller.unref();
  try {
    const clientPath = join(directory, "say.cjs");
    await writeFile(clientPath, sayClientSource(directory, token), { mode: 0o600 });

    const commandPath = join(directory, process.platform === "win32" ? "coxswain-say.cmd" : "coxswain-say");
    if (process.platform === "win32") {
      const nodeMode = needsElectronNodeMode ? "set ELECTRON_RUN_AS_NODE=1\r\n" : "";
      const command = `@echo off\r\n${nodeMode}"${clientRuntime}" "${clientPath}" %*\r\n`;
      await writeFile(commandPath, command, { mode: 0o700 });
    } else {
      const nodeMode = needsElectronNodeMode ? "ELECTRON_RUN_AS_NODE=1 " : "";
      const command = `#!/bin/sh\n${nodeMode}exec ${shellQuote(clientRuntime)} ${shellQuote(clientPath)} "$@"\n`;
      await writeFile(commandPath, command, { mode: 0o700 });
      await chmod(commandPath, 0o700);
    }

    const pathKey = Object.keys(process.env).find((key) => key.toLowerCase() === "path") ?? "PATH";
    const inheritedPath = process.env[pathKey];
    const executablePath = inheritedPath === undefined
      ? directory
      : `${directory}${delimiter}${inheritedPath}`;
    return {
      command: commandPath,
      env: { [pathKey]: executablePath, [SAY_ENV_NAME]: commandPath },
      async dispose() {
        if (disposed) {
          return;
        }
        disposed = true;
        clearInterval(poller);
        await awaitScan();
        await rm(directory, { force: true, recursive: true });
      },
    };
  } catch (error) {
    disposed = true;
    clearInterval(poller);
    await awaitScan();
    await rm(directory, { force: true, recursive: true });
    throw error;
  }
}
