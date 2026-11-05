import type { AgentSession } from "@earendil-works/pi-coding-agent";

interface PiQueueBarrier {
  pending(): boolean;
  begin(requestId: string): void;
  settled(): void;
  responded(requestId: string): void;
  observeRun(): void;
}

/** Keep adapter-held input behind native settlement actions and its own acceptance. */
export function piQueueBarrier(session: Pick<AgentSession, "isStreaming" | "waitForIdle">, drain: () => void): PiQueueBarrier {
  let prompts = 0;
  let idleWait = false;
  const responses = new Set<string>();
  // An independent run has no adapter prompt promise. Arm its idle wait while
  // it is active: at agent_settled, isIdle is already true and the same call
  // would resolve before Pi awaits its deferred extension actions.
  function observeRun(): void {
    if (prompts > 0 || idleWait || !session.isStreaming) { return; }
    idleWait = true;
    void (async (): Promise<void> => {
      try { await session.waitForIdle(); }
      catch { /* Native events remain authoritative for failure and liveness. */ }
      finally { idleWait = false; drain(); }
    })();
  }
  return {
    pending: () => prompts > 0 || idleWait || responses.size > 0,
    begin(requestId) { prompts += 1; responses.add(requestId); },
    // prompt() awaits settlement's deferred actions; this runs only after its
    // promise finishes, including any preflight refusal or handler outcome.
    settled() { prompts -= 1; observeRun(); drain(); },
    responded(requestId) { responses.delete(requestId); drain(); },
    observeRun,
  };
}
