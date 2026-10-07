import type { AgentSession } from "@earendil-works/pi-coding-agent";

const SHUTDOWN_TIMEOUT_MS = 10_000;

/** Await native extension shutdown while its context is live, but never let an async hook hold the host forever. */
export async function disposePiAgentSession(session: AgentSession): Promise<void> {
  let timer: ReturnType<typeof setTimeout> | undefined = undefined;
  try {
    const deadline = new Promise<boolean>((resolve) => {
      timer = setTimeout(() => { resolve(false); }, SHUTDOWN_TIMEOUT_MS);
    });
    const completed = await Promise.race([
      session.extensionRunner.emit({ type: "session_shutdown", reason: "quit" }).then(() => true),
      deadline,
    ]);
    if (!completed) {
      // The public runner does not identify the currently executing handler.
      // This is an adapter deadline, so report it through Node's diagnostic
      // channel (like http.ts), not as a fabricated native frame.
      process.emitWarning(
        `pi session_shutdown hooks timed out after ${String(SHUTDOWN_TIMEOUT_MS)} ms for session ${session.sessionId}; releasing the session without waiting for remaining hooks`,
        { code: "OAR_PI_SHUTDOWN_TIMEOUT" },
      );
    }
  } finally {
    clearTimeout(timer);
    session.dispose();
  }
}
