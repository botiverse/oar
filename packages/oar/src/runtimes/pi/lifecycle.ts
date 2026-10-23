import type { AgentSession } from "@earendil-works/pi-coding-agent";

const SHUTDOWN_TIMEOUT_MS = 10_000;

/** Bound native abort and extension shutdown together while their context is live. */
export async function disposePiAgentSession(session: AgentSession, abort = false): Promise<void> {
  let timer: ReturnType<typeof setTimeout> | undefined = undefined;
  let expired = false;
  const shutdown = async (): Promise<boolean> => {
    if (abort) { await session.abort(); }
    // An abort can settle after forced cleanup. Never start hooks on a context
    // that has already been invalidated by the deadline.
    if (expired) { return false; }
    await session.extensionRunner.emit({ type: "session_shutdown", reason: "quit" });
    return true;
  };
  try {
    const deadline = new Promise<boolean>((resolve) => {
      timer = setTimeout(() => { expired = true; resolve(false); }, SHUTDOWN_TIMEOUT_MS);
    });
    const completed = await Promise.race([shutdown(), deadline]);
    if (!completed) {
      // The public runner does not identify the currently executing handler.
      // This is an adapter deadline, so report it through Node's diagnostic
      // channel (like http.ts), not as a fabricated native frame.
      process.emitWarning(
        `pi ${abort ? "abort and " : ""}session_shutdown hooks timed out after ${String(SHUTDOWN_TIMEOUT_MS)} ms for session ${session.sessionId}; releasing the session without waiting for remaining hooks`,
        { code: "OAR_PI_SHUTDOWN_TIMEOUT" },
      );
    }
  } finally {
    expired = true;
    clearTimeout(timer);
    session.dispose();
  }
}
