/* oxlint-disable typescript/promise-function-async -- Test helpers deliberately return the SDK's native promises. */
import assert from "node:assert/strict";
import { fileURLToPath } from "node:url";
import { afterEach, expect, test } from "vitest";
import { AcpError } from "../../packages/oar/src/shared/acp/errors.js";
import {
  createAcpClient,
  startAcpProcess,
  withAcpDeadline,
  type AcpProcess,
} from "../../packages/oar/src/shared/acp/process.js";
import { asRecord, type JsonRecord } from "../../packages/oar/src/shared/json.js";

const fixture = fileURLToPath(new URL("../fixtures/fake-acp-agent.mjs", import.meta.url));
const runtimes: AcpProcess[] = [];

function record(value: unknown): JsonRecord {
  return asRecord(value) ?? {};
}

function start(app = createAcpClient({ name: "test" })): AcpProcess {
  const runtime = startAcpProcess(process.execPath, [fixture, "rpc"], app);
  runtimes.push(runtime);
  return runtime;
}

async function request<Response = JsonRecord>(
  runtime: AcpProcess,
  method: string,
  params: JsonRecord,
): Promise<Response> {
  return withAcpDeadline(
    runtime,
    method,
    500,
    (options) => runtime.connection.agent.request<Response>(method, params, options),
  );
}

afterEach(async () => {
  await Promise.all(runtimes.splice(0).map(async (runtime) => {
    runtime.kill();
    await runtime.exited;
  }));
});

test("the official ACP SDK handles requests, notifications, and reverse requests", async () => {
  const notifications: unknown[] = [];
  const app = createAcpClient({ name: "test" })
    .onRequest<JsonRecord, JsonRecord>("fixture/reverse", record, ({ params }) => ({
      method: "fixture/reverse",
      answer: params.question,
    }))
    .onNotification<JsonRecord>("fixture/notification", record, ({ params }) => {
      notifications.push({ method: "fixture/notification", params });
    });
  const runtime = start(app);
  assert.deepEqual(await request(runtime, "test/echo", { value: 42 }), { value: 42 });
  await request(runtime, "test/notify", {});
  const reverse = await request(runtime, "test/reverse", {});

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

test("ACP deadlines cancel one SDK request without killing the process", async () => {
  const runtime = start();
  await assert.rejects(
    withAcpDeadline(
      runtime,
      "test/timeout",
      30,
      (options) => runtime.connection.agent.request("test/timeout", {}, options),
    ),
    (error: unknown) => error instanceof AcpError
      && error.kind === "timeout"
      && error.method === "test/timeout"
      && error.timeoutMs === 30,
  );
  assert.deepEqual(await request(runtime, "test/echo", { alive: true }), { alive: true });
});

test("ACP process exit rejects in-flight SDK work with the exit code", async () => {
  const runtime = start();
  await assert.rejects(
    withAcpDeadline(
      runtime,
      "test/exit",
      null,
      (options) => runtime.connection.agent.request("test/exit", {}, options),
    ),
    (error: unknown) => error instanceof AcpError
      && error.kind === "process_exited"
      && error.exitCode === 7,
  );
  assert.equal(await runtime.exited, 7);
  assert.equal(runtime.closed, true);
});

test("authentication transport exit keeps native diagnostics private", async () => {
  const runtime = startAcpProcess(process.execPath, [fileURLToPath(new URL("../fixtures/fake-acp-open-error.mjs", import.meta.url))], createAcpClient({ name: "auth-test" }), {
    inheritStderr: false,
    env: { ...process.env, OAR_CHILD_STDERR: "inherit", FAKE_EXIT_METHOD: "initialize", FAKE_STDERR: "private authentication diagnostic sk-private-auth-token-1234567890" },
    redact: () => "authentication query failed",
  });
  runtimes.push(runtime);
  const failure: unknown = await request(runtime, "initialize", {}).catch((error: unknown) => error);
  expect(failure).toBeInstanceOf(AcpError);
  expect(failure).toMatchObject({ kind: "process_exited", exitCode: 1, message: "ACP process exited with code 1" });
  expect(failure instanceof Error && failure.cause).toBeUndefined();
});

test("the SDK recovers after an invalid NDJSON frame", async () => {
  const runtime = start();
  assert.deepEqual(await request(runtime, "test/invalid", {}), { recovered: true });
  assert.equal(runtime.closed, false);
});
