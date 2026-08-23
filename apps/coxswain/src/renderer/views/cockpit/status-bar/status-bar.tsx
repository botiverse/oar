import { useState } from "react";
import type { AgentViewUpdate, SessionIdentity, TurnOutcomeView } from "../../../../shared/ipc.js";

interface StatusPresentation {
  readonly label: string;
  readonly lampClass: string;
  readonly lampColor: string;
}

function statusPresentation(view: AgentViewUpdate): StatusPresentation {
  if (view.status.kind === "idle") {
    return { label: "idle", lampClass: "lamp-idle", lampColor: "bg-oar-500" };
  }
  const phase = view.status.phase;
  if (typeof phase === "object") {
    return { label: `tool · ${phase.tool}`, lampClass: "lamp-tool", lampColor: "bg-sky-400" };
  }
  switch (phase) {
    case "waiting_model":
      return { label: "waiting model", lampClass: "lamp-waiting", lampColor: "bg-oar-500" };
    case "thinking":
      return { label: "thinking", lampClass: "lamp-thinking", lampColor: "bg-oar-500" };
    case "responding":
      return { label: "responding", lampClass: "lamp-responding", lampColor: "bg-oar-500" };
  }
  throw new Error("Unknown agent phase");
}

function outcomeAnnotation(outcome: TurnOutcomeView | undefined): {
  readonly copy: string;
  readonly className: string;
} | null {
  if (outcome === undefined) {
    return null;
  }
  switch (outcome.kind) {
    case "completed":
      return { copy: "last turn completed", className: "text-zinc-600" };
    case "aborted":
      return { copy: "last turn aborted", className: "text-zinc-600" };
    case "failed":
      return {
        copy: `last turn failed · ${outcome.failure} · ${outcome.reason}`,
        className: "text-rose-400/80",
      };
  }
  throw new Error("Unknown turn outcome");
}

export function StatusBar(props: {
  readonly agentView: AgentViewUpdate;
  readonly session: SessionIdentity;
}): React.JSX.Element {
  const [aborting, setAborting] = useState(false);
  const [abortError, setAbortError] = useState<string | null>(null);
  const presentation = statusPresentation(props.agentView);
  const stalled = props.agentView.stall;
  const status = props.agentView.status;
  const outcome = status.kind === "idle" ? outcomeAnnotation(status.lastTurnOutcome) : null;
  const identity = `${props.session.runtimeId} · ${props.session.model ?? "default"} · ${props.session.sessionId.slice(0, 8)}`;

  const abort = async (): Promise<void> => {
    setAborting(true);
    setAbortError(null);
    try {
      const receipt = await window.coxswain.abort();
      if (!receipt.aborted) {
        setAbortError("turn already ended");
      }
    } catch (error) {
      setAbortError(error instanceof Error ? error.message : "abort failed");
    } finally {
      setAborting(false);
    }
  };

  return (
    <header
      className={`flex h-10 shrink-0 items-center gap-3 border-b bg-ink-900 px-4 font-mono text-[11.5px] ${
        stalled === null ? "border-white/5" : "border-amber-500/20"
      }`}
      data-simple-state={props.agentView.simple}
      data-status-kind={status.kind}
    >
      <span className="font-sans text-sm font-semibold tracking-tight text-zinc-200">coxswain</span>
      <span className={`lamp size-2.5 shrink-0 rounded-full ${
        stalled === null ? `${presentation.lampColor} ${presentation.lampClass}` : "lamp-stalled bg-amber-500"
      }`} />
      <span className="font-sans text-xs font-medium text-zinc-200">{presentation.label}</span>
      {status.kind === "running" ? (
        <span className="text-zinc-500">· turn {status.turnId.slice(0, 8)}</span>
      ) : null}
      {stalled === null ? null : (
        <span className="font-sans text-xs text-amber-500">
          · silent {Math.floor(stalled.silentForMs / 1000)}s
        </span>
      )}
      {outcome === null ? null : (
        <span className={`max-w-[42%] truncate ${outcome.className}`}>· {outcome.copy}</span>
      )}
      {status.kind === "running" ? (
        <button
          className="rounded border border-white/10 px-2 py-0.5 font-sans text-[11px] text-zinc-400 hover:text-zinc-200 disabled:opacity-40"
          data-action="abort"
          disabled={aborting}
          onClick={() => {
            void abort();
          }}
          type="button"
        >
          {aborting ? "aborting…" : "abort turn"}
        </button>
      ) : null}
      {abortError === null ? null : <span className="text-rose-400/70">· {abortError}</span>}
      <span className="ml-auto shrink-0 text-zinc-600">{identity}</span>
    </header>
  );
}
