import type { AgentSession } from "@earendil-works/pi-coding-agent";

/** Pi 1.0.4's runtime host awaits shutdown while the extension context is still live. */
export async function disposePiAgentSession(session: AgentSession): Promise<void> {
  try {
    await session.extensionRunner.emit({ type: "session_shutdown", reason: "quit" });
  } finally {
    session.dispose();
  }
}
