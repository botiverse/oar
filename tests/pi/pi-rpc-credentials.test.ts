import { Duplex } from "node:stream";
import { setImmediate } from "node:timers/promises";
import { expect, test } from "vitest";
import { readPiRpcCredentials, servePiRpcPipe } from "../../packages/oar/src/runtimes/pi/rpc/credentials.js";

function pipeHarness(config?: string) {
  const replies: string[] = [];
  const received: string[] = [];
  const reports: (readonly unknown[])[] = [];
  let failed = 0;
  const pipe = new Duplex({
    read() { /* Data is pushed below, as if received from the native hook. */ },
    // oxlint-disable-next-line promise/prefer-await-to-callbacks -- Node's Duplex write hook reports writes through this callback.
    write(chunk: Uint8Array | string, _encoding, callback) { replies.push(typeof chunk === "string" ? chunk : Buffer.from(chunk).toString("utf8")); callback(); },
  });
  servePiRpcPipe(pipe, {
    ...(config === undefined ? {} : { config }),
    remember: (key) => { received.push(key); },
    failed: () => { failed += 1; },
    tools: (tools) => { reports.push(tools); },
  });
  return { pipe, replies, received, reports, failures: () => failed };
}

test("a peer closing before the credential acknowledgment fails without an unhandled readline error", async () => {
  const received: string[] = [];
  let failed = false;
  const pipe = new Duplex({
    read() { /* Data is pushed below, as if received from the native hook. */ },
    // oxlint-disable-next-line promise/prefer-await-to-callbacks -- Node's Duplex write hook reports failure through this callback.
    write(_chunk, _encoding, callback) { callback(new Error("write EPIPE")); },
  });
  readPiRpcCredentials(pipe, (key) => { received.push(key); }, () => { failed = true; });
  pipe.push('"private-provider-key"\n');
  await setImmediate();
  expect(received).toEqual(["private-provider-key"]);
  expect(failed).toBe(true);
  expect(pipe.destroyed).toBe(true);
});

test("EPIPE while writing startup config fails without an unhandled readline error", async () => {
  let failed = false;
  const pipe = new Duplex({
    read() { /* Data is pushed below, as if received from the native hook. */ },
    // oxlint-disable-next-line promise/prefer-await-to-callbacks -- Node's Duplex write hook reports failure through this callback.
    write(_chunk, _encoding, callback) { callback(new Error("write EPIPE")); },
  });
  servePiRpcPipe(pipe, { config: '{"servers":[]}', remember: () => {}, failed: () => { failed = true; } });
  pipe.push('{"type":"config"}\n');
  await setImmediate();
  expect(failed).toBe(true);
  expect(pipe.destroyed).toBe(true);
});

test("servePiRpcPipe serves startup config once before registering provider keys", async () => {
  const config = JSON.stringify({ servers: [{ name: "echo", config: { headers: { Authorization: "Bearer secret" } } }] });
  const h = pipeHarness(config);
  h.pipe.push('{"type":"config"}\n"private-provider-key"\n');
  await setImmediate();
  expect({ replies: h.replies, received: h.received, failures: h.failures() }).toEqual({
    replies: [`${config}\n`, "ok\n"], received: ["private-provider-key"], failures: 0,
  });
  h.pipe.push('{"type":"config"}\n');
  await setImmediate();
  expect({ replies: h.replies.length, failures: h.failures() }).toEqual({ replies: 2, failures: 1 });
});

test("servePiRpcPipe burns pending config after invalid input or out-of-order key registration", async () => {
  const afterError = pipeHarness('{"secret":true}');
  afterError.pipe.push('{not json\n{"type":"config"}\n');
  const afterKey = pipeHarness('{"secret":true}');
  afterKey.pipe.push('"provider-key"\n{"type":"config"}\n');
  await setImmediate();
  expect(afterError.replies).toEqual([]);
  expect(afterError.failures()).toBe(2);
  expect(afterKey.replies).toEqual(["ok\n"]);
  expect(afterKey.failures()).toBe(1);
});

test("servePiRpcPipe rejects config requests when no config was supplied or on invalid input", async () => {
  const h = pipeHarness();
  h.pipe.push('{"type":"config"}\n{not json\n');
  await setImmediate();
  expect(h.replies).toEqual([]);
  expect(h.failures()).toBe(2);
});

test("the child's tool report is kept and acknowledged without touching startup config", async () => {
  const h = pipeHarness('{"servers":[]}');
  h.pipe.push('{"type":"tools","tools":[{"name":"read","path":"builtin:read","source":"builtin"},{"name":"Checklist","path":"/ext/checklist.ts","source":"checklist"}]}\n');
  await setImmediate();
  // The report asks for nothing back but its acknowledgement, and it must not
  // consume the one startup config the child still expects.
  expect(h.replies).toEqual(["ok\n"]);
  expect(h.failures()).toBe(0);
  expect(h.reports).toHaveLength(1);
  expect(h.reports[0]).toEqual([
    { name: "read", path: "builtin:read", source: "builtin" },
    { name: "Checklist", path: "/ext/checklist.ts", source: "checklist" },
  ]);
  h.pipe.push('{"type":"config"}\n');
  await setImmediate();
  expect(h.replies.at(-1)).toEqual('{"servers":[]}\n');
});

test("a report OAR cannot read is acknowledged and records nothing, never a guessed extension", async () => {
  const h = pipeHarness();
  h.pipe.push('{"type":"tools","tools":[{"name":"half"}]}\n');
  await setImmediate();
  expect(h.replies).toEqual(["ok\n"]);
  expect(h.failures()).toBe(0);
  expect(h.reports).toEqual([[]]);
});
