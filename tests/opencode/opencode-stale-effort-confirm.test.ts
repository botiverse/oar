import { expect, test } from "vitest";
import { opencodeV2AcpProfile } from "../../packages/oar/src/runtimes/opencode/session.js";
import { createAcpConfigUpdates } from "../../packages/oar/src/shared/acp/config-updates.js";
import { applyAcpEffort } from "../../packages/oar/src/shared/acp/effort.js";
import type { AcpProcess } from "../../packages/oar/src/shared/acp/process.js";

function fakeAcpProcess(request: (method: string, params: unknown) => Promise<unknown>): AcpProcess {
  const { signal } = new AbortController();
  // oxlint-disable-next-line typescript/consistent-type-assertions, typescript/no-unsafe-type-assertion -- Minimal ACP transport stub for applyAcpEffort unit tests.
  return { connection: { signal, agent: { request } } } as unknown as AcpProcess;
}

const thoughtMenu = (currentValue: string) => ({
  configOptions: [{
    id: "effort",
    category: "thought_level",
    currentValue,
    options: [{ value: "default" }, { value: "low" }, { value: "high" }],
  }],
});

test("OpenCode v2 enables confirmConfigOptionUpdates: when_stale and waits only on stale answers", async () => {
  expect(opencodeV2AcpProfile.confirmConfigOptionUpdates).toBe("when_stale");

  const updates = createAcpConfigUpdates();
  // oxlint-disable-next-line eslint/require-await -- Stub ACP request handler returns an immediate updated answer.
  const immediateProcess = fakeAcpProcess(async () => thoughtMenu("high"));
  const immediate = await applyAcpEffort(
    immediateProcess,
    { sessionId: "ses-1", openMethod: "session/new", response: thoughtMenu("default") },
    "high",
    { timeoutMs: 500, updates, confirmWhenStale: true, observe: () => {} },
  );
  expect(immediate).toEqual(thoughtMenu("high"));

  // oxlint-disable-next-line eslint/require-await -- Stub ACP request handler returns stale default, then emits config_option_update.
  const staleProcess = fakeAcpProcess(async () => {
    queueMicrotask(() => {
      updates.observe({
        sessionId: "ses-2",
        update: { sessionUpdate: "config_option_update", ...thoughtMenu("high") },
      });
    });
    return thoughtMenu("default");
  });
  const stale = await applyAcpEffort(
    staleProcess,
    { sessionId: "ses-2", openMethod: "session/new", response: thoughtMenu("default") },
    "high",
    { timeoutMs: 500, updates, confirmWhenStale: true, observe: () => {} },
  );
  expect(stale).toEqual({ sessionUpdate: "config_option_update", ...thoughtMenu("high") });
});
