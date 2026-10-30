import { ndJsonStream } from "../../packages/oar/node_modules/@agentclientprotocol/sdk/dist/acp.js";
import { expect, test } from "vitest";
import { acpEofInput } from "../../packages/oar/src/shared/acp/input.js";
import { createAcpClient } from "../../packages/oar/src/shared/acp/process.js";

function nativeInput(message: unknown): ReadableStream<Uint8Array> {
  return new ReadableStream<Uint8Array>({
    start(controller) { controller.enqueue(new TextEncoder().encode(`${JSON.stringify(message)}\n`)); controller.close(); },
  });
}

test("normal EOF preserves the last notification and has its own SDK close identity", async () => {
  const received: unknown[] = [];
  const wire = ndJsonStream(new WritableStream<Uint8Array>(), nativeInput({ jsonrpc: "2.0", method: "fixture/last", params: { value: "last" } }));
  const input = acpEofInput(wire.readable);
  const connection = createAcpClient({ name: "eof" }).onNotification("fixture/last", value => value, ({ params }) => { received.push(params); })
    .connect({ writable: wire.writable, readable: input.readable });
  await connection.closed;
  expect(received).toEqual([{ value: "last" }]);
  expect(connection.signal.reason).toBe(input.eof);
});

test("a batch immediately followed by EOF retains the protocol failure", async () => {
  const wire = ndJsonStream(new WritableStream<Uint8Array>(), nativeInput([{ jsonrpc: "2.0", method: "fixture/batch", params: {} }]));
  const input = acpEofInput(wire.readable);
  const connection = createAcpClient({ name: "batch" }).connect({ writable: wire.writable, readable: input.readable });
  await connection.closed;
  expect(connection.signal.reason).not.toBe(input.eof);
  expect(connection.signal.reason).toBeInstanceOf(TypeError);
  expect(String(connection.signal.reason)).toContain("batches are not supported");
});

test.each(["read", "write"])("a native %s failure is not mistaken for normal EOF", async (operation) => {
  const failure = new Error(`native ${operation} failed`);
  const wire = ndJsonStream(new WritableStream<Uint8Array>({ write() { if (operation === "write") { throw failure; } } }),
    new ReadableStream<Uint8Array>({ start(controller) { if (operation === "read") { controller.error(failure); } } }));
  const input = acpEofInput(wire.readable);
  const connection = createAcpClient({ name: "failed-stream" }).connect({ writable: wire.writable, readable: input.readable });
  if (operation === "write") { await expect(connection.agent.request("fixture/write", {})).rejects.toBe(failure); }
  await connection.closed;
  expect(connection.signal.reason).toBe(failure);
  expect(connection.signal.reason).not.toBe(input.eof);
});
