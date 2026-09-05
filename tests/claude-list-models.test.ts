import { afterEach, expect, test, vi } from "vitest";
import { claudeListModels } from "../packages/oar/src/runtimes/claude/list-models.js";
import { asRecord } from "../packages/oar/src/shared/json.js";
import { fakeLineProcess, type FakeLineProcess } from "./fixtures/fake-line-process.js";

const spawnLineProcess = vi.hoisted(() => vi.fn<(
  command: string,
  args: readonly string[],
  options: { env?: NodeJS.ProcessEnv },
) => FakeLineProcess>());
vi.mock("../packages/oar/src/shared/executable/index.js", () => ({ spawnLineProcess }));

const installation = { kind: "available", via: "executable", command: "claude", version: "2.1.237" } as const;

afterEach(() => {
  spawnLineProcess.mockReset();
});

function requestIdOf(text: string): string {
  const id = asRecord(JSON.parse(text))?.request_id;
  if (typeof id !== "string") {
    throw new TypeError("control_request without request_id");
  }
  return id;
}

test("claude lister answers from the matching control_response only", async () => {
  const fake = fakeLineProcess((text, self) => {
    const requestId = requestIdOf(text);
    self.emit(`${JSON.stringify({ type: "system", subtype: "init" })}\n`);
    self.emit(`${JSON.stringify({
      type: "control_response",
      response: { subtype: "success", request_id: "someone-else", response: { models: [{ value: "wrong" }] } },
    })}\n`);
    self.emit(`${JSON.stringify({
      type: "control_response",
      response: {
        subtype: "success",
        request_id: requestId,
        response: { models: [{ value: "sonnet", resolvedModel: "claude-sonnet-5", supportedEffortLevels: ["low"] }] },
      },
    })}\n`);
  });
  spawnLineProcess.mockReturnValue(fake);
  await expect(claudeListModels(installation)).resolves.toEqual({
    kind: "ok",
    models: [{ id: "sonnet", resolvedId: "claude-sonnet-5", effortLevels: ["low"] }],
  });
  const request: unknown = JSON.parse(fake.written[0] ?? "");
  expect(request).toMatchObject({ type: "control_request", request: { subtype: "list_models" } });
  expect(fake.killed()).toBe(true);
  const [, args, options] = spawnLineProcess.mock.calls[0] ?? [];
  expect(args).toEqual(["-p", "--input-format", "stream-json", "--output-format", "stream-json", "--verbose"]);
  expect(options?.env?.CLAUDECODE).toBeUndefined();
});

test("claude lister maps a login error to unauthenticated", async () => {
  const fake = fakeLineProcess((text, self) => {
    self.emit(`${JSON.stringify({
      type: "control_response",
      response: { subtype: "error", request_id: requestIdOf(text), error: "Not logged in. Please run /login" },
    })}\n`);
  });
  spawnLineProcess.mockReturnValue(fake);
  await expect(claudeListModels(installation)).resolves.toEqual({
    kind: "unauthenticated",
    detail: "Not logged in. Please run /login",
  });
});

test("claude lister fails when the process exits before answering", async () => {
  const fake = fakeLineProcess((_text, self) => {
    self.emit("garbage\n");
    self.end(1);
  });
  spawnLineProcess.mockReturnValue(fake);
  await expect(claudeListModels(installation)).rejects.toThrow(/exited before answering/u);
});

test("claude lister kills the process on timeout", async () => {
  const fake = fakeLineProcess();
  spawnLineProcess.mockReturnValue(fake);
  await expect(claudeListModels(installation, { timeoutMs: 20 })).rejects.toThrow(/exited before answering/u);
  expect(fake.killed()).toBe(true);
});
