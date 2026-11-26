/* oxlint-disable import/max-dependencies -- This composition root aggregates every shared trial case group. */
import type { TrialCase } from "../harness/runner.js";
import { accountUsageCases } from "./account-usage.js";
import { installationCases } from "./installation.js";
import { sessionCases } from "./session.js";
import { sessionAnswerCases } from "./session-answer.js";
import { sessionCapabilitiesCases } from "./session-capabilities.js";
import { sessionDisposeCases } from "./session-dispose.js";
import { sessionEffortCases } from "./session-effort.js";
import { sessionImagesCases } from "./session-images.js";
import { sessionQueueSnapshotCases } from "./session-queue-snapshot.js";
import { sessionWithdrawCases } from "./session-withdraw.js";

/** The shared behavior suite: every case runs on every backend and skips only by capability. */
export const trialCases: readonly TrialCase[] = [
  ...installationCases,
  ...accountUsageCases,
  ...sessionCases,
  ...sessionCapabilitiesCases,
  ...sessionAnswerCases,
  ...sessionDisposeCases,
  ...sessionEffortCases,
  ...sessionImagesCases,
  ...sessionQueueSnapshotCases,
  ...sessionWithdrawCases,
];
