import type { AvailableInstallation } from "./installation.js";
import type { SessionOptions } from "./session-options.js";

export interface SideQuestionOptions {
  readonly sessionId: string;
  readonly cwd: string;
  readonly question: string;
  readonly env?: SessionOptions["env"];
  readonly model?: string;
  readonly timeoutMs?: number;
  readonly signal?: AbortSignal;
}

/** Ask once from a discarded native fork. Administrator policy remains in force. */
export type AskSideQuestion = (installation: AvailableInstallation, options: SideQuestionOptions) => Promise<string>;
