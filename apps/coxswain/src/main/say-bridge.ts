import { randomUUID } from "node:crypto";
import { chmod, mkdtemp, rm, writeFile } from "node:fs/promises";
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { delimiter, join } from "node:path";

const MAX_SAY_BYTES = 1024 * 1024;

export interface SayBridge {
  readonly env: Readonly<Record<string, string>>;
  dispose(): Promise<void>;
}

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : "Unknown say bridge error";
}

async function readBody(request: IncomingMessage): Promise<string> {
  return new Promise((resolve, reject) => {
    let body = "";
    request.setEncoding("utf8");
    request.on("data", (chunk: string) => {
      body += chunk;
      if (Buffer.byteLength(body, "utf8") > MAX_SAY_BYTES) {
        reject(new Error("say payload is too large"));
        request.destroy();
      }
    });
    request.once("end", () => {
      resolve(body);
    });
    request.once("error", reject);
  });
}

function textFromBody(body: string): string {
  let parsed: unknown = null;
  try {
    parsed = JSON.parse(body);
  } catch {
    throw new Error("say payload must be JSON");
  }
  if (typeof parsed !== "object" || parsed === null) {
    throw new Error("say payload must be an object");
  }
  if (!("text" in parsed) || typeof parsed.text !== "string" || parsed.text.trim().length === 0) {
    throw new Error("say text must be a non-empty string");
  }
  return parsed.text.trim();
}

async function handleRequest(
  request: IncomingMessage,
  response: ServerResponse,
  token: string,
  onSay: (text: string) => void,
): Promise<void> {
  if (request.method !== "POST" || request.url !== "/say") {
    response.writeHead(404).end();
    return;
  }
  if (request.headers.authorization !== `Bearer ${token}`) {
    response.writeHead(401).end();
    return;
  }
  try {
    onSay(textFromBody(await readBody(request)));
    response.writeHead(204).end();
  } catch (error) {
    response.writeHead(400, { "content-type": "application/json" });
    response.end(JSON.stringify({ error: messageOf(error) }));
  }
}

function shellQuote(value: string): string {
  return `'${value.replaceAll("'", `'"'"'`)}'`;
}

function sayClientSource(url: string, token: string): string {
  return `"use strict";
const http = require("node:http");

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
  const payload = JSON.stringify({ text });
  const request = http.request(${JSON.stringify(url)}, {
    method: "POST",
    headers: {
      authorization: ${JSON.stringify(`Bearer ${token}`)},
      "content-length": Buffer.byteLength(payload),
      "content-type": "application/json",
    },
  }, (response) => {
    let body = "";
    response.setEncoding("utf8");
    response.on("data", (chunk) => { body += chunk; });
    response.once("end", () => {
      if (response.statusCode !== 204) {
        process.stderr.write(body.length > 0 ? body + "\\n" : "say failed\\n");
        process.exitCode = 1;
      }
    });
  });
  request.once("error", (error) => {
    process.stderr.write(error.message + "\\n");
    process.exitCode = 1;
  });
  request.end(payload);
})().catch((error) => {
  process.stderr.write(String(error) + "\\n");
  process.exitCode = 1;
});
`;
}

async function listen(server: ReturnType<typeof createServer>): Promise<AddressInfo> {
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => {
      server.off("error", reject);
      resolve();
    });
  });
  const address = server.address();
  if (address === null || typeof address === "string") {
    throw new Error("say bridge did not receive a TCP address");
  }
  return address;
}

async function closeServer(server: ReturnType<typeof createServer>): Promise<void> {
  if (!server.listening) {
    return;
  }
  await new Promise<void>((resolve, reject) => {
    server.close((error) => {
      if (error === undefined) {
        resolve();
      } else {
        reject(error);
      }
    });
  });
}

export async function createSayBridge(onSay: (text: string) => void): Promise<SayBridge> {
  const token = randomUUID();
  const server = createServer((request, response) => {
    void handleRequest(request, response, token, onSay);
  });
  const directory = await mkdtemp(join(tmpdir(), "coxswain-say-"));
  try {
    const address = await listen(server);
    const url = `http://127.0.0.1:${address.port}/say`;
    const clientPath = join(directory, "say.cjs");
    await writeFile(clientPath, sayClientSource(url, token), { mode: 0o600 });

    if (process.platform === "win32") {
      const commandPath = join(directory, "say.cmd");
      const command = `@echo off\r\nset ELECTRON_RUN_AS_NODE=1\r\n"${process.execPath}" "${clientPath}" %*\r\n`;
      await writeFile(commandPath, command, { mode: 0o700 });
    } else {
      const commandPath = join(directory, "say");
      const command = `#!/bin/sh\nELECTRON_RUN_AS_NODE=1 exec ${shellQuote(process.execPath)} ${shellQuote(clientPath)} "$@"\n`;
      await writeFile(commandPath, command, { mode: 0o700 });
      await chmod(commandPath, 0o700);
    }

    const pathKey = Object.keys(process.env).find((key) => key.toLowerCase() === "path") ?? "PATH";
    const inheritedPath = process.env[pathKey];
    const executablePath = inheritedPath === undefined
      ? directory
      : `${directory}${delimiter}${inheritedPath}`;
    let disposed = false;
    return {
      env: { [pathKey]: executablePath },
      async dispose() {
        if (disposed) {
          return;
        }
        disposed = true;
        await closeServer(server);
        await rm(directory, { force: true, recursive: true });
      },
    };
  } catch (error) {
    await closeServer(server);
    await rm(directory, { force: true, recursive: true });
    throw error;
  }
}
