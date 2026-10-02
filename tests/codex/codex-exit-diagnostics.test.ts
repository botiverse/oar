import assert from "node:assert/strict";
import { afterEach, expect, test, vi } from "vitest";
import { startAppServerClient } from "../../packages/oar/src/runtimes/codex/app-server-client.js";
import { fakeLineProcess, type FakeLineProcess } from "../fixtures/fake-line-process.js";

const spawnLineProcess = vi.hoisted(() => vi.fn<() => FakeLineProcess>());
vi.mock("../../packages/oar/src/shared/executable/index.js", () => ({ spawnLineProcess }));
afterEach(() => { spawnLineProcess.mockReset(); });

test("pending and later RPCs retain the native exit reason and stderr", async () => {
  const fake = fakeLineProcess();
  spawnLineProcess.mockReturnValue(fake);
  const client = startAppServerClient("codex");
  const pending = client.request("initialize", {});
  fake.emitStderr("startup failed\n");
  fake.end(17);
  const failure: unknown = await pending.catch((error: unknown) => error);
  assert.ok(failure instanceof Error);
  expect({ message: failure.message, cause: failure.cause }).toMatchInlineSnapshot(`
    {
      "cause": {
        "exitCode": 17,
        "signal": null,
        "stderr": "startup failed
    ",
      },
      "message": "app-server exited: exit code 17; signal none
    stderr (tail):
    startup failed
    ",
    }
  `);
  await expect(client.request("thread/start", {})).rejects.toBe(failure);
});

test("an app-server killed by a signal reports the signal", async () => {
  const fake = fakeLineProcess();
  spawnLineProcess.mockReturnValue(fake);
  const client = startAppServerClient("codex");
  fake.emitStderr("native fatal error");
  fake.end(null, "SIGKILL");
  const failure: unknown = await client.request("initialize", {}).catch((error: unknown) => error);
  assert.ok(failure instanceof Error);
  expect(failure.message).toMatchInlineSnapshot(`
    "app-server exited: exit code unavailable; signal SIGKILL
    stderr (tail):
    native fatal error"
  `);
});
