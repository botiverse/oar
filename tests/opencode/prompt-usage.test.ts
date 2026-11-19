import { expect, test } from "vitest";
import { createAcpTokenUsage } from "../../packages/oar/src/shared/acp/token-usage.js";
import { opencodeAcpProfile, opencodeV2AcpProfile } from "../../packages/oar/src/runtimes/opencode/session.js";

// The upstream two-step ACP translation control has nonzero counts in all five categories.
const usage = { inputTokens: 120, outputTokens: 15, thoughtTokens: 3, cachedReadTokens: 150, cachedWriteTokens: 50, totalTokens: 338 };
const initialized = (version: unknown) => ({ agentInfo: { version } });

test.each(["2.0.22", "2.2.5", "2.3.2"])("OpenCode %s accounts for each prompt once with cache inside input and reasoning inside output", version => {
  const ledger = createAcpTokenUsage(opencodeV2AcpProfile);
  const report = ledger.prompt({ usage }, initialized(version));
  expect(report).toEqual({ kind: "usage", usage: { tokens: { input: 320, output: 18, reasoning: 3, cacheRead: 150, cacheWrite: 50 } } });
  expect(report?.kind === "usage" && report.usage.tokens && report.usage.tokens.input + report.usage.tokens.output).toBe(usage.totalTokens);
  expect(ledger.prompt({}, initialized(version))).toBeNull();
  expect(ledger.prompt({ usage: { inputTokens: 10, outputTokens: 2, totalTokens: 12 } }, initialized(version)))
    .toEqual({ kind: "usage", usage: { tokens: { input: 330, output: 20, reasoning: 3, cacheRead: 150, cacheWrite: 50 } } });
});

test.each(["1.19.6", "2.0.21", "2.0.22-rc.1", "unknown", "2.3.2oops", undefined])("isolates an unverified usage ledger on %s", version => {
  expect(createAcpTokenUsage(opencodeV2AcpProfile).prompt({ usage }, initialized(version))).toBeNull();
  expect(createAcpTokenUsage(opencodeAcpProfile).prompt({ usage }, initialized(version))).toBeNull();
});

test("absent and zero parts stay distinct, and inconsistent native totals do not advance the ledger", () => {
  const ledger = createAcpTokenUsage(opencodeV2AcpProfile);
  const read = (fields: Record<string, unknown>) => ledger.prompt({ usage: { inputTokens: 0, outputTokens: 0, totalTokens: 0, ...fields } }, initialized("2.3.2"));
  expect(read({})).toEqual({ kind: "usage", usage: { tokens: { input: 0, output: 0 } } });
  expect(read({ cachedWriteTokens: -1 })).toBeNull();
  expect(read({ totalTokens: 1 })).toBeNull();
  expect(read({ thoughtTokens: "3" })).toBeNull();
  expect(read({ thoughtTokens: 0, cachedReadTokens: 0, cachedWriteTokens: 0 }))
    .toEqual({ kind: "usage", usage: { tokens: { input: 0, output: 0, reasoning: 0, cacheRead: 0, cacheWrite: 0 } } });
});
