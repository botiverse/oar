/* oxlint-disable max-statements -- Each test observes both sides of streaming, truncation or cleanup barriers. */
import { createServer, type Server } from "node:http";
import { mkdtemp, readFile, readdir, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, expect, test, vi } from "vitest";
import { asRecord, parseJson } from "../packages/oar/src/shared/json.js";
import { startAntigravityAimock } from "../sea-trial/harness/aimock-acp.js";
import { providerEvidenceWriter } from "../sea-trial/harness/provider-evidence.js";
import { geminiToolResultsAsUser, startRawCapture, type ProviderCaptureEvent } from "../sea-trial/harness/raw-capture.js";

afterEach(() => { vi.unstubAllEnvs(); });

async function listen(server: Server): Promise<string> {
  const ready = Promise.withResolvers<void>();
  server.listen(0, "127.0.0.1", () => { ready.resolve(); });
  await ready.promise;
  const address = server.address();
  if (typeof address !== "object" || address === null) { throw new Error("No server address"); }
  return `http://127.0.0.1:${String(address.port)}`;
}

async function stop(server: Server): Promise<void> {
  server.closeAllConnections();
  const closed = Promise.withResolvers<void>();
  server.close(() => { closed.resolve(); });
  await closed.promise;
}

function lines(text: string): Record<string, unknown>[] {
  return text.trim().split("\n").map(line => asRecord(parseJson(line)) ?? {});
}

test("evidence preserves a first streamed chunk before completion and separates overlapping requests", async () => {
  const finish = Promise.withResolvers<void>();
  const events: ProviderCaptureEvent[] = [];
  const server = createServer((request, response) => {
    response.writeHead(200, { "content-type": "text/event-stream" });
    response.write(`data: ${request.url ?? ""}\n\n`);
    async function end(): Promise<void> { await finish.promise; response.end("data: end\n\n"); }
    void end();
  });
  const proxy = await startRawCapture(await listen(server), undefined, undefined, event => { events.push(event); });
  try {
    const first = await fetch(`${proxy.url}/first`, { method: "POST", body: "{}" });
    const second = await fetch(`${proxy.url}/second`, { method: "POST", body: "{}" });
    const reader = first.body?.getReader();
    expect(reader).toBeDefined();
    const chunk = await reader?.read();
    expect(Buffer.from(chunk?.value ?? []).toString()).toBe("data: /first\n\n");
    expect(events.some(event => event.kind === "response_end")).toBe(false);
    expect(events.filter(event => event.kind === "response_chunk").map(event => [event.requestId, Buffer.from(event.base64, "base64").toString()])).toEqual([
      [1, "data: /first\n\n"], [2, "data: /second\n\n"],
    ]);
    finish.resolve();
    expect(await second.text()).toBe("data: /second\n\ndata: end\n\n");
    const last = await reader?.read();
    expect(Buffer.from(last?.value ?? []).toString()).toBe("data: end\n\n");
    const ended = await reader?.read();
    expect(ended?.done).toBe(true);
    expect(events.filter(event => event.kind === "response_end").map(event => event.requestId).toSorted((a, b) => a - b)).toEqual([1, 2]);
  } finally {
    finish.resolve();
    await proxy.stop();
    await stop(server);
  }
});

test("captures native and forwarded requests and actual rewritten bytes without headers or query secrets", async () => {
  const events: ProviderCaptureEvent[] = [];
  let received = "";
  let transport: { url: string | undefined; authorization: string | undefined } | null = null;
  const server = createServer((request, response) => {
    transport = { url: request.url, authorization: request.headers.authorization };
    request.setEncoding("utf8");
    request.on("data", (chunk: string) => { received += chunk; });
    request.on("end", () => { response.writeHead(429); response.end("original"); });
  });
  const proxy = await startRawCapture(await listen(server), body => `${body}:rewritten`, geminiToolResultsAsUser, event => { events.push(event); });
  const body = { contents: [{ role: "model", parts: [{ functionResponse: { name: "echo", response: "result" } }] }] };
  try {
    const response = await fetch(`${proxy.url}/provider?key=synthetic-query-secret`, {
      method: "POST", headers: { Authorization: "Bearer synthetic-header-secret" }, body: JSON.stringify(body),
    });
    expect(response.status).toBe(429);
    expect(await response.text()).toBe("original:rewritten");
    expect(JSON.parse(received)).toEqual(geminiToolResultsAsUser(body));
    expect(transport).toEqual({ url: "/provider?key=synthetic-query-secret", authorization: "Bearer synthetic-header-secret" });
    expect(events[0]).toEqual({ kind: "request", requestId: 1, path: "/provider", body, forwardedBody: geminiToolResultsAsUser(body) });
    expect(events.filter(event => event.kind === "response_chunk").map(event => Buffer.from(event.base64, "base64").toString())).toEqual(["original:rewritten"]);
    expect(JSON.stringify(events)).not.toMatch(/synthetic-(?:query|header)-secret/u);
  } finally { await proxy.stop(); await stop(server); }
});

test("a broken observer cannot replace a provider error response", async () => {
  const server = createServer((_request, response) => { response.writeHead(503); response.end("original failure"); });
  const proxy = await startRawCapture(await listen(server), undefined, undefined, () => { throw new Error("diagnostics failed"); });
  try {
    const response = await fetch(proxy.url, { method: "POST", body: "not JSON" });
    expect(response.status).toBe(503);
    expect(await response.text()).toBe("original failure");
  } finally { await proxy.stop(); await stop(server); }
});

test("partial response evidence survives a disconnected upstream", async () => {
  const dropped = Promise.withResolvers<void>();
  const closeReply = Promise.withResolvers<void>();
  const events: ProviderCaptureEvent[] = [];
  const server = createServer((_request, response) => {
    response.writeHead(200); response.write("partial");
    async function end(): Promise<void> { await closeReply.promise; response.destroy(); }
    void end();
  });
  const proxy = await startRawCapture(await listen(server), undefined, undefined, event => {
    events.push(event);
    if (event.kind === "response_closed") { dropped.resolve(); }
  });
  try {
    const response = await fetch(proxy.url, { method: "POST", body: "{}" });
    const reader = response.body?.getReader();
    const part = await reader?.read();
    expect(Buffer.from(part?.value ?? []).toString()).toBe("partial");
    closeReply.resolve();
    await dropped.promise;
    expect(events).toContainEqual({ kind: "response_closed", requestId: 1, complete: false });
    expect(events.some(event => event.kind === "response_end")).toBe(false);
    expect(events).toContainEqual({ kind: "response_chunk", requestId: 1, base64: Buffer.from("partial").toString("base64") });
    await reader?.cancel();
  } finally { closeReply.resolve(); await proxy.stop(); await stop(server); }
});

test("writes matcher and provider evidence before fixture cleanup, outside its HOME", async () => {
  const dir = await mkdtemp(path.join(tmpdir(), "oar-provider-evidence-"));
  vi.stubEnv("OAR_TRIAL_RUN_DIR", dir);
  const fixture = await startAntigravityAimock(mock => { mock.onMessage("check evidence", { content: "echoed" }); });
  let stopped = false;
  try {
    const response = await fetch(`${fixture.env.GOOGLE_GEMINI_BASE_URL ?? ""}/v1beta/models/gemini:generateContent`, {
      method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ contents: [{ role: "user", parts: [{ text: "check evidence" }] }] }),
    });
    expect(response.status).toBe(200);
    expect(await response.text()).toContain("echoed");
    const [file] = await readdir(path.join(dir, "acp-provider"));
    const location = path.join(dir, "acp-provider", file ?? "missing");
    const entries = lines(await readFile(location, "utf8"));
    expect(entries).toEqual(expect.arrayContaining([
      expect.objectContaining({ kind: "request", requestId: 1 }),
      expect.objectContaining({ kind: "matcher_request", journalIndex: 0, fixtureIndex: 0, status: 200 }),
      expect.objectContaining({ kind: "response_end", requestId: 1 }),
    ]));
    await fixture.stop();
    stopped = true;
    expect(await readFile(location, "utf8")).toContain("check evidence");
    await expect(stat(fixture.env.HOME ?? "missing")).rejects.toThrow();
  } finally {
    if (!stopped) { await fixture.stop(); }
    await rm(dir, { recursive: true, force: true });
  }
});

test("caps both entries and whole files, keeping explicit truncation markers", async () => {
  const dir = await mkdtemp(path.join(tmpdir(), "oar-provider-budget-"));
  try {
    const file = path.join(dir, "provider.jsonl");
    const write = providerEvidenceWriter(file);
    write({ kind: "request", requestId: 1, body: `${"x".repeat(1024 * 1024)}sentinel-tail` });
    for (let i = 0; i < 12; i++) { write({ kind: "request", requestId: i + 2, body: "x".repeat(900_000) }); }
    const entries = lines(await readFile(file, "utf8"));
    expect(entries[0]).toMatchObject({ kind: "entry_truncated", eventKind: "request", requestId: 1 });
    expect(entries[0]?.tail).toContain("sentinel-tail");
    expect(entries.at(-1)).toMatchObject({ kind: "file_truncated" });
    const metadata = await stat(file);
    expect(metadata.size).toBeLessThanOrEqual(8 * 1024 * 1024);
  } finally { await rm(dir, { recursive: true, force: true }); }
});
