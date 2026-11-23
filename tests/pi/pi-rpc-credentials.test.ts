import { Duplex } from "node:stream";
import { setImmediate } from "node:timers/promises";
import { expect, test } from "vitest";
import { readPiRpcCredentials, servePiRpcPipe } from "../../packages/oar/src/runtimes/pi/rpc/credentials.js";

function pipeHarness(config?: string) {
  const replies: string[] = [];
  const received: string[] = [];
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
  });
  return { pipe, replies, received, failures: () => failed };
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

test("servePiRpcPipe serves startup config once before registering provider keys", async () => {
  const config = JSON.stringify({ servers: [{ name: "echo", config: { headers: { Authorization: "Bearer secret" } } }] });
  const h = pipeHarness(config);
  h.pipe.push('{"type":"config"}\n"private-provider-key"\n');
  await setImmediate();
  expect(h.replies).toEqual([`${config}\n`, "ok\n"]);
  expect(h.received).toEqual(["private-provider-key"]);
  expect(h.failures()).toBe(0);
  h.pipe.push('{"type":"config"}\n');
  await setImmediate();
  expect(h.failures()).toBe(1);
});

test("servePiRpcPipe rejects config requests when no config was supplied or on invalid input", async () => {
  const h = pipeHarness();
  h.pipe.push('{"type":"config"}\n{not json\n');
  await setImmediate();
  expect(h.replies).toEqual([]);
  expect(h.failures()).toBe(2);
});
