import { useState } from "react";
import type {
  AbortReceipt,
  AgentViewUpdate,
  SessionIdentity,
} from "../../../shared/ipc.js";
import { Activity } from "../cockpit/activity/activity.js";
import { Conversation } from "../cockpit/conversation/conversation.js";
import type { BroadcastReceipt, RegattaLaneState } from "./regatta-model.js";

export interface RegattaViewProps {
  readonly lanes: readonly RegattaLaneState[];
  readonly onBroadcast: (text: string) => Promise<BroadcastReceipt>;
  readonly onAbort: (laneId: string) => Promise<AbortReceipt>;
}

function phaseLabel(view: AgentViewUpdate): string {
  if (view.stall !== null) {
    return `silent ${Math.floor(view.stall.silentForMs / 1000)}s`;
  }
  if (view.status.kind === "idle") {
    return view.status.lastTurnOutcome?.kind === "failed" ? "error" : "idle";
  }
  if (typeof view.status.phase === "object") {
    return `tool · ${view.status.phase.tool}`;
  }
  switch (view.status.phase) {
    case "waiting_model":
      return "waiting model";
    case "thinking":
      return "thinking";
    case "responding":
      return "responding";
  }
  throw new Error("Unknown agent phase");
}

function lampClass(view: AgentViewUpdate): string {
  switch (view.simple) {
    case "idle":
      return "bg-oar-500";
    case "busy":
      return "bg-oar-500 animate-pulse";
    case "stuck":
      return "bg-amber-500 animate-pulse";
    case "error":
      return "bg-rose-400";
  }
  throw new Error("Unknown simple agent state");
}

function laneIdentity(identity: SessionIdentity): string {
  return `${identity.runtimeId} · ${identity.model ?? "default"} · ${identity.sessionId.slice(0, 8)}`;
}

function LaneHeader(props: {
  readonly lane: RegattaLaneState;
  readonly onAbort: () => Promise<AbortReceipt>;
}): React.JSX.Element {
  const [aborting, setAborting] = useState(false);
  const [abortError, setAbortError] = useState<string | null>(null);
  const running = props.lane.agentView.status.kind === "running";

  const abort = async (): Promise<void> => {
    setAborting(true);
    setAbortError(null);
    try {
      const receipt = await props.onAbort();
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
      className="flex h-11 shrink-0 items-center gap-2 border-b border-white/5 bg-ink-900 px-3 font-mono text-[10.5px]"
      data-lane-header={props.lane.identity.laneId}
      data-simple-state={props.lane.agentView.simple}
    >
      <span className={`size-2 shrink-0 rounded-full ${lampClass(props.lane.agentView)}`} />
      <span className="font-sans text-xs font-semibold text-zinc-200">
        {props.lane.identity.runtimeId}
      </span>
      <span className="truncate text-zinc-600" title={laneIdentity(props.lane.identity)}>
        {props.lane.identity.model ?? "default"} · {props.lane.identity.sessionId.slice(0, 8)}
      </span>
      <span className="ml-auto shrink-0 text-zinc-500">{phaseLabel(props.lane.agentView)}</span>
      {running ? (
        <button
          className="rounded border border-white/10 px-1.5 py-0.5 font-sans text-[10px] text-zinc-500 hover:text-zinc-200 disabled:opacity-40"
          data-action="abort-lane"
          disabled={aborting}
          onClick={() => {
            void abort();
          }}
          type="button"
        >
          {aborting ? "…" : "abort"}
        </button>
      ) : null}
      {abortError === null ? null : <span className="max-w-24 truncate text-rose-400/80" title={abortError}>{abortError}</span>}
    </header>
  );
}

function BroadcastComposer(props: {
  readonly onBroadcast: (text: string) => Promise<BroadcastReceipt>;
  readonly disabled: boolean;
  readonly laneCount: number;
}): React.JSX.Element {
  const [text, setText] = useState("");
  const [pending, setPending] = useState(false);
  const [feedback, setFeedback] = useState<string | null>(null);

  const send = async (): Promise<void> => {
    const message = text.trim();
    if (message.length === 0 || pending || props.disabled) {
      return;
    }
    setPending(true);
    setFeedback(null);
    try {
      const receipt = await props.onBroadcast(message);
      if (receipt.accepted === 0) {
        setFeedback(receipt.rejected.join("; ") || "No lane accepted the prompt");
      } else {
        setText("");
        if (receipt.rejected.length > 0) {
          setFeedback(`${receipt.accepted}/${receipt.total} lanes accepted · ${receipt.rejected.join("; ")}`);
        }
      }
    } catch (error) {
      setFeedback(error instanceof Error ? error.message : "Prompt could not be broadcast");
    } finally {
      setPending(false);
    }
  };

  return (
    <form
      className="shrink-0 border-t border-white/5 bg-ink-900 px-5 py-3"
      data-role="regatta-composer"
      onSubmit={(event) => {
        event.preventDefault();
        void send();
      }}
    >
      <div className="flex items-end gap-3">
        <div className="min-w-0 flex-1 overflow-hidden rounded-xl border border-white/10 bg-ink-850 focus-within:border-oar-700">
          <textarea
            aria-label="Broadcast prompt to every lane"
            className="w-full resize-none bg-transparent px-4 pt-2.5 text-sm text-zinc-200 outline-none placeholder:text-zinc-600 disabled:opacity-60"
            data-role="broadcast-composer"
            disabled={pending || props.disabled}
            onChange={(event) => {
              setText(event.target.value);
            }}
            onKeyDown={(event) => {
              if (event.key === "Enter" && !event.shiftKey) {
                event.preventDefault();
                void send();
              }
            }}
            placeholder="broadcast a prompt to every lane…"
            rows={2}
            value={text}
          />
          <div className="px-4 pb-2 text-[10.5px] text-zinc-600">
            one prompt · {props.disabled
              ? props.laneCount === 0 ? "no active lanes" : "waiting for all lanes to finish"
              : "each lane receives its own turn"}
          </div>
        </div>
        <button
          className="shrink-0 rounded-md bg-oar-600 px-4 py-2 text-xs font-semibold text-ink-950 hover:bg-oar-500 disabled:opacity-40"
          data-action="broadcast"
          disabled={pending || props.disabled || text.trim().length === 0}
          type="submit"
        >
          {pending ? "sending…" : "broadcast"}
        </button>
      </div>
      {feedback === null ? null : <p className="mt-1.5 text-xs text-rose-400/80">{feedback}</p>}
    </form>
  );
}

function LaneColumn(props: {
  readonly lane: RegattaLaneState;
  readonly onAbort: (laneId: string) => Promise<AbortReceipt>;
}): React.JSX.Element {
  return (
    <section
      className="flex min-h-0 min-w-0 flex-1 flex-col border-r border-white/8 last:border-r-0"
      data-lane={props.lane.identity.laneId}
    >
      <LaneHeader
        lane={props.lane}
        onAbort={async () => props.onAbort(props.lane.identity.laneId)}
      />
      {props.lane.hostError === null ? null : (
        <div className="shrink-0 truncate border-b border-rose-500/10 bg-rose-500/5 px-3 py-1 text-[10px] text-rose-400/80" title={props.lane.hostError}>
          host · {props.lane.hostError}
        </div>
      )}
      <div className="flex min-h-0 flex-1">
        <Conversation
          agentView={props.lane.agentView}
          entries={props.lane.conversation}
          showComposer={false}
        />
        <Activity
          agentView={props.lane.agentView}
          compact
          events={props.lane.activity}
          laneId={props.lane.identity.laneId}
          runtimeId={props.lane.identity.runtimeId}
        />
      </div>
    </section>
  );
}

export function RegattaView(props: RegattaViewProps): React.JSX.Element {
  // The first Regatta slice intentionally starts synchronized turns only;
  // steering stays out of the shared composer until a later slice.
  const canBroadcast = props.lanes.length > 0
    && props.lanes.every((lane) => lane.agentView.status.kind === "idle");

  return (
    <main className="flex h-full min-h-0 flex-col bg-ink-950 text-zinc-300" data-view="regatta">
      <header className="flex h-10 shrink-0 items-center gap-3 border-b border-white/5 bg-ink-900 px-4">
        <span className="font-sans text-sm font-semibold tracking-tight text-zinc-200">coxswain</span>
        <span className="font-mono text-[11px] uppercase tracking-wide text-oar-600">regatta</span>
        <span className="text-xs text-zinc-600">same prompt · {props.lanes.length} lanes</span>
        <span className="ml-auto font-mono text-[10px] text-zinc-600">side by side</span>
      </header>
      <div className="flex min-h-0 flex-1">
        {props.lanes.map((lane) => (
          <LaneColumn
            key={lane.identity.laneId}
            lane={lane}
            onAbort={props.onAbort}
          />
        ))}
      </div>
      <BroadcastComposer
        disabled={!canBroadcast}
        laneCount={props.lanes.length}
        onBroadcast={props.onBroadcast}
      />
    </main>
  );
}
