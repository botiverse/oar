import { expect, test } from "vitest";
import { piCompaction } from "../../packages/oar/src/runtimes/pi/compaction.js";
import { createSessionKernel } from "../../packages/oar/src/shared/session-kernel.js";

test("Pi manual compaction classifies Nothing to compact as not_compacted while keeping real errors as native_failed", () => {
  const k1 = createSessionKernel("pi-1");
  // oxlint-disable-next-line eslint/require-await -- Stub compaction callback returns a resolved promise.
  const op1 = piCompaction(k1, async () => undefined);
  expect(op1.observe(k1.frame({ type: "compaction_start", native: {}, events: [{ kind: "compaction_started", trigger: "manual" }] }))).toBeNull();
  expect(op1.observe(k1.frame({
    type: "compaction_end",
    native: {},
    events: [{ kind: "compaction_ended", outcome: "failed", trigger: "manual", reason: "Compaction failed: Nothing to compact (session too small)" }],
  }))).toMatchObject({ kind: "failed", code: "not_compacted" });

  const k2 = createSessionKernel("pi-2");
  // oxlint-disable-next-line eslint/require-await -- Stub compaction callback returns a resolved promise.
  const op2 = piCompaction(k2, async () => undefined);
  expect(op2.observe(k2.frame({ type: "compaction_start", native: {}, events: [{ kind: "compaction_started", trigger: "manual" }] }))).toBeNull();
  expect(op2.observe(k2.frame({
    type: "compaction_end",
    native: {},
    events: [{ kind: "compaction_ended", outcome: "failed", trigger: "manual", reason: "gateway denied summary request" }],
  }))).toMatchObject({ kind: "failed", code: "native_failed" });
});
