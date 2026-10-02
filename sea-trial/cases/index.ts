import { accountUsageCases } from "./account-usage.js";
import { installationCases } from "./installation.js";
import { sessionCases } from "./session.js";
import { sessionDisposeCases } from "./session-dispose.js";
import { sessionEffortCases } from "./session-effort.js";
import { sessionImagesCases } from "./session-images.js";
import { sessionResumeOverridesCases } from "./session-resume-overrides.js";

/** Every sea-trial case, in the order the suite runs them. */
export const cases = [
  ...installationCases,
  ...accountUsageCases,
  ...sessionCases,
  ...sessionDisposeCases,
  ...sessionEffortCases,
  ...sessionImagesCases,
  ...sessionResumeOverridesCases,
];
