import type { TrialCase } from "../harness/runner.js";
import { accountUsageCases } from "./account-usage.js";
import { installationCases } from "./installation.js";
import { sessionCases } from "./session.js";
import { sessionDisposeCases } from "./session-dispose.js";
import { sessionEffortCases } from "./session-effort.js";
import { sessionImagesCases } from "./session-images.js";
import { sessionWithdrawCases } from "./session-withdraw.js";

/** The shared behavior suite: every case runs on every backend and skips only by capability. */
export const trialCases: readonly TrialCase[] = [
  ...installationCases,
  ...accountUsageCases,
  ...sessionCases,
  ...sessionDisposeCases,
  ...sessionEffortCases,
  ...sessionImagesCases,
  ...sessionWithdrawCases,
];
