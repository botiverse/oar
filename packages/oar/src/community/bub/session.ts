import type { StartSession } from "../../contracts/session.js";
import { acpSession, type AcpSessionProfile } from "../../shared/acp/session.js";
import { wholePromptTokenUsage } from "../../shared/acp/token-usage.js";
import { refuseSessionOptions } from "../../shared/session-options.js";
import { bubFailureOutcome, bubOpenFailure } from "./failure.js";
import { bubConfigureModel } from "./model.js";
import { bubRefusedSessionOptions } from "./options.js";

export const bubAcpProfile: AcpSessionProfile = {
  args: ["acp"],
  // Steering is a Lody extension (`_lody/session/steer`) whose answer waits
  // for the running tool call to end, or starts a new turn when none runs, so
  // the session has no `steer`. Bub queues a prompt sent during a turn, but
  // OAR holds queued input itself. Subagent frames are Lody extensions too.
  capabilities: { queue: { durable: false }, attribution: "opaque" },
  // session/new and session/resume list the provider's models over the network.
  requestTimeoutMs: 30_000,
  validateOptions: (options) => { refuseSessionOptions(bubRefusedSessionOptions, options); },
  // A resume takes any id and any cwd, and the session's tape is named after
  // both, so a resume elsewhere or of an unknown id opens an empty history.
  // OAR resumes only a listed session, in its listed cwd.
  resumeKeepsSessionCwd: true,
  // session/close removes the session from Bub's index (the tape stays), and
  // a resume could then not be confirmed; ending the process only detaches.
  detachOnDispose: true,
  promptTokenUsage: wholePromptTokenUsage,
  failureOutcome: bubFailureOutcome,
  openFailure: bubOpenFailure,
  modelViaConfigOption: true,
  configureModel: bubConfigureModel,
};

export const bubSession: StartSession = acpSession(bubAcpProfile);
