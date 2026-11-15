/* oxlint-disable promise/prefer-await-to-then, promise/always-return, typescript/promise-function-async -- Explicit promise settlement is observed before advancing the virtual deadline. */
import { afterEach, expect, test, vi } from "vitest";
import { createAcpConfigUpdates } from "../../packages/oar/src/shared/acp/config-updates.js";
import { acpProcessExitedError, acpRequestTimeoutError } from "../../packages/oar/src/shared/acp/errors.js";
import { ModelConfirmationError } from "../../packages/oar/src/contracts/model-confirmation-error.js";

function scenario(configId = "model") {
  const updates = createAcpConfigUpdates();
  const controller = new AbortController();
  const answer = Promise.withResolvers<string>();
  const limit = Promise.withResolvers<never>();
  const deadline = acpRequestTimeoutError("session/set_config_option", 1000);
  const result = updates.confirm("session", configId, "requested", wait => {
    const timer = setTimeout(() => { controller.abort(deadline); limit.reject(deadline); }, 1000);
    const request = answer.promise.then(async response => { await wait(controller.signal); return response; });
    return Promise.race([request, limit.promise]).finally(() => { clearTimeout(timer); });
  });
  let settled = false;
  void result.then(() => { settled = true; }, () => { settled = true; });
  return { result, answer, settled: (): boolean => settled,
    update: (currentValue: unknown, sessionId = "session", id = configId): void => {
      updates.observe({ sessionId, update: { sessionUpdate: "config_option_update", configOptions: [{ id, currentValue }] } });
    },
    exit: (): void => { controller.abort(acpProcessExitedError(17)); },
  };
}

afterEach(() => { vi.useRealTimers(); });

test.each(["model", "thought_level"])("%s waits through disagreement, then accepts the positive native value", async configId => {
  vi.useFakeTimers();
  const probe = scenario(configId);
  probe.answer.resolve("native response");
  probe.update("old");
  await vi.advanceTimersByTimeAsync(500);
  expect(probe.settled()).toBe(false);
  probe.update("requested");
  await expect(probe.result).resolves.toBe("native response");
});

// oxlint-disable-next-line eslint/max-statements -- Compare the state immediately before and exactly at the deadline.
test.each(["old", null, 23])("persistent model disagreement uses its final value at the original deadline: %s", async value => {
  vi.useFakeTimers();
  const probe = scenario();
  const failure = expect(probe.result).rejects.toMatchObject({ name: "ModelConfirmationError", requested: "requested", reported: typeof value === "string" ? value : null });
  probe.answer.resolve("native response");
  probe.update("first wrong value");
  await vi.advanceTimersByTimeAsync(999);
  expect(probe.settled()).toBe(false);
  probe.update(value);
  await vi.advanceTimersByTimeAsync(1);
  await failure;
  await expect(probe.result).rejects.toBeInstanceOf(ModelConfirmationError);
});

test("persistent effort disagreement keeps the existing refusal after waiting to the deadline", async () => {
  vi.useFakeTimers();
  const probe = scenario("thought_level");
  const failure = expect(probe.result).rejects.toThrow("config_option_update left thought_level at low");
  probe.answer.resolve("native response"); probe.update("low");
  await vi.advanceTimersByTimeAsync(999); expect(probe.settled()).toBe(false);
  await vi.advanceTimersByTimeAsync(1); await failure;
  await expect(probe.result).rejects.not.toBeInstanceOf(ModelConfirmationError);
});

test("unrelated notifications cannot replace missing confirmation or extend its deadline", async () => {
  vi.useFakeTimers();
  const probe = scenario();
  const failure = expect(probe.result).rejects.toMatchObject({ kind: "timeout" });
  probe.answer.resolve("native response");
  probe.update("requested", "different session"); probe.update("requested", "session", "different option");
  await vi.advanceTimersByTimeAsync(999); expect(probe.settled()).toBe(false);
  await vi.advanceTimersByTimeAsync(1); await failure;
});

test("the last notification before the RPC answer must match, even after an earlier match", async () => {
  vi.useFakeTimers();
  const probe = scenario();
  probe.update("requested"); probe.update("old");
  probe.answer.resolve("native response");
  await vi.advanceTimersByTimeAsync(500); expect(probe.settled()).toBe(false);
  probe.update("requested"); await expect(probe.result).resolves.toBe("native response");
});

test("a contradictory update in the same callback batch prevents premature success", async () => {
  vi.useFakeTimers();
  const probe = scenario();
  probe.answer.resolve("native response");
  await vi.advanceTimersByTimeAsync(0);
  probe.update("requested"); probe.update("old");
  await vi.advanceTimersByTimeAsync(500); expect(probe.settled()).toBe(false);
  probe.update("requested"); await expect(probe.result).resolves.toBe("native response");
});

test("RPC failure wins immediately over an earlier conflicting notification", async () => {
  vi.useFakeTimers();
  const probe = scenario(), rpcError = new Error("native RPC failure");
  const failure = expect(probe.result).rejects.toBe(rpcError);
  probe.update("old"); probe.answer.reject(rpcError);
  await vi.advanceTimersByTimeAsync(0); await failure;
  expect(probe.settled()).toBe(true);
});

test("a process exit after the RPC answer fails immediately while confirmation is pending", async () => {
  vi.useFakeTimers();
  const probe = scenario();
  const failure = expect(probe.result).rejects.toMatchObject({ kind: "process_exited", exitCode: 17 });
  probe.answer.resolve("native response"); probe.update("old");
  await vi.advanceTimersByTimeAsync(0); probe.exit();
  await vi.advanceTimersByTimeAsync(0); await failure;
  expect(probe.settled()).toBe(true);
});
