import { Duplex } from "node:stream";
import { setImmediate } from "node:timers/promises";
import { expect, test } from "vitest";
import { readPiRpcCredentials } from "../../packages/oar/src/runtimes/pi/rpc/credentials.js";

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
