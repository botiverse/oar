import assert from "node:assert/strict";
import { fileURLToPath } from "node:url";
import { afterEach, expect, test } from "vitest";
import { AcpError } from "../packages/oar/src/shared/acp/errors.js";
import {
  startAcpJsonRpcClient,
  type AcpJsonRpcClient,
} from "../packages/oar/src/shared/acp/json-rpc.js";

const fixture = fileURLToPath(new URL("fixtures/fake-acp-agent.mjs", import.meta.url));
const clients: AcpJsonRpcClient[] = [];

function start(options: Parameters<typeof startAcpJsonRpcClient>[2] = {}): AcpJsonRpcClient {
  const client = startAcpJsonRpcClient(process.execPath, [fixture, "rpc"], options);
  clients.push(client);
  return client;
}

afterEach(async () => {
  await Promise.all(clients.splice(0).map(async (client) => {
    client.kill();
    await client.exited;
  }));
});

test("ACP JSON-RPC frames requests, notifications, and reverse requests", async () => {
  const client = start({
    reverseRequest: (method, params) => ({ method, answer: params.question }),
    reverseRequestMethods: ["fixture/reverse"],
    notificationMethods: ["fixture/notification"],
  });
  await client.spawned;
  assert.deepEqual(await client.request("test/echo", { value: 42 }), { value: 42 });

  const notifications: unknown[] = [];
  client.onNotification((method, params) => {
    notifications.push({ method, params });
  });
  await client.request("test/notify", {});
  const reverse = await client.request("test/reverse", {});

  expect({ notifications, reverse }).toMatchInlineSnapshot(`
    {
      "notifications": [
        {
          "method": "fixture/notification",
          "params": {
            "value": 42,
          },
        },
      ],
      "reverse": {
        "reverse": {
          "answer": "answer me",
          "method": "fixture/reverse",
        },
      },
    }
  `);
});

test("ACP JSON-RPC deadlines cancel and reject one request without killing the client", async () => {
  const client = start();
  await assert.rejects(
    client.request("test/timeout", {}, { timeoutMs: 30 }),
    (error: unknown) => error instanceof AcpError
      && error.kind === "timeout"
      && error.method === "test/timeout"
      && error.timeoutMs === 30,
  );
  assert.deepEqual(await client.request("test/echo", { alive: true }), { alive: true });
});

test("ACP JSON-RPC process exit rejects in-flight work with the exit code", async () => {
  const client = start();
  const exitCodes: (number | null)[] = [];
  client.onExit((code) => {
    exitCodes.push(code);
  });
  await assert.rejects(
    client.request("test/exit", {}),
    (error: unknown) => error instanceof AcpError
      && error.kind === "process_exited"
      && error.exitCode === 7,
  );
  await client.exited;
  assert.deepEqual(exitCodes, [7]);
  assert.equal(client.closed, true);
});

test("the SDK recovers after an invalid NDJSON frame", async () => {
  const client = start();
  assert.deepEqual(
    await client.request("test/invalid", {}, { timeoutMs: 500 }),
    { recovered: true },
  );
  assert.equal(client.closed, false);
});
