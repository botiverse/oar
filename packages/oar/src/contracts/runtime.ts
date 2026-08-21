import type { SessionOptions, StartSession, TurnOutcome } from "./session.js";
import type { AccountUsageReader } from "./account-usage.js";
import type { InstallationProbe } from "./installation.js";

/** One provider-independent runtime adoption unit. */
export interface Runtime {
  readonly id: string;
  readonly session: StartSession; // the core capability — a runtime without sessions is not usable
  readonly installation?: InstallationProbe;
  readonly accountUsage?: AccountUsageReader;
  /**
   * DERIVED business-embedding facade: probe → ephemeral session → one turn →
   * collected text → dispose. Pure composition over `session`; there is
   * deliberately no second SPI behind it.
   */
  run(prompt: string, options: SessionOptions): Promise<RunResult>;
}

/** What a runtime module declares; defineRuntime derives the rest. This is the SPI face of Runtime. */
export type RuntimeSpec = Omit<Runtime, "run">;

export interface RunResult {
  readonly sessionId: string;
  readonly outcome: TurnOutcome;
  readonly text: string;
}
