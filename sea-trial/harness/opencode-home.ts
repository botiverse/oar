import type { AvailableInstallation } from "../../packages/oar/src/contracts/installation.js";
import { opencodeSession } from "../../packages/oar/src/runtimes/opencode/session.js";
import { record } from "./trace.js";

/** Initialize one fixture's database serially before its concurrent behavior cases. */
export function opencodePreparation(env: Readonly<Record<string, string>>): (installation: AvailableInstallation) => Promise<void> {
  let prepared: Promise<void> | undefined = undefined;
  async function prepare(installation: AvailableInstallation): Promise<void> {
    const started = performance.now();
    const observation = { kind: "opencode_preparation", dataDirectory: env.XDG_DATA_HOME, version: installation.via === "executable" ? installation.version ?? null : null };
    try {
      // Use the independent entry even when the Runtime supports shared placement.
      // No prompt: initialization and shutdown cannot consume scripted replies.
      const session = await opencodeSession(installation, { cwd: env.HOME ?? process.cwd(), env });
      await session.dispose();
      record({ ...observation, outcome: "ready", elapsedMs: performance.now() - started });
    } catch (error) {
      record({ ...observation, outcome: "failed", elapsedMs: performance.now() - started, error: error instanceof Error ? error.message : String(error) });
      throw error;
    }
  }
  return async (installation) => { prepared ??= prepare(installation); await prepared; };
}
