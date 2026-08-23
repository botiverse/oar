import { useEffect, useRef, useState, type KeyboardEvent, type SubmitEvent } from "react";
import type { AgentViewUpdate, ConversationEntry, TurnOutcomeView } from "../../../../shared/ipc.js";

function clockTime(timestamp: number): string {
  return new Date(timestamp).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });
}

function deliveryLabel(delivery: "prompted" | "steered" | "queued"): string | null {
  return delivery === "prompted" ? null : delivery;
}

function outcomeCopy(outcome: TurnOutcomeView): { readonly text: string; readonly failure: boolean } {
  switch (outcome.kind) {
    case "completed":
      return { text: "turn completed", failure: false };
    case "aborted":
      return { text: "turn aborted by you", failure: false };
    case "failed":
      return { text: `turn failed · ${outcome.failure} · ${outcome.reason}`, failure: true };
  }
  throw new Error("Unknown turn outcome");
}

function ConversationItem({ entry }: { readonly entry: ConversationEntry }): React.JSX.Element {
  if (entry.kind === "outcome") {
    const outcome = outcomeCopy(entry.outcome);
    return (
      <li className={`text-center text-[11px] ${outcome.failure ? "text-rose-400/70" : "text-zinc-600"}`} data-entry-kind="outcome">
        — {outcome.text} —
      </li>
    );
  }
  if (entry.kind === "human") {
    const delivery = deliveryLabel(entry.delivery);
    return (
      <li className="flex justify-end" data-entry-kind="human">
        <div className="max-w-[70%]">
          <div className="mb-1 text-right text-[11px] text-zinc-600">
            you · {clockTime(entry.receivedAt)}
            {delivery === null ? null : <span className="text-amber-500/80"> · {delivery}</span>}
          </div>
          <div className="whitespace-pre-wrap rounded-2xl rounded-tr-sm bg-ink-700 px-4 py-2.5 text-sm text-zinc-200">
            {entry.text}
          </div>
        </div>
      </li>
    );
  }
  return (
    <li className="flex" data-entry-kind="agent">
      <div className="max-w-[70%]">
        <div className="mb-1 text-[11px] text-zinc-600">
          <span className="font-medium text-oar-600">agent</span> · via say · {clockTime(entry.receivedAt)}
        </div>
        <div className="whitespace-pre-wrap rounded-2xl rounded-tl-sm border border-white/5 bg-ink-850 px-4 py-2.5 text-sm text-zinc-300">
          {entry.text}
        </div>
      </div>
    </li>
  );
}

export function Conversation(props: {
  readonly entries: readonly ConversationEntry[];
  readonly agentView: AgentViewUpdate;
}): React.JSX.Element {
  const [text, setText] = useState("");
  const [pending, setPending] = useState(false);
  const [sendError, setSendError] = useState<string | null>(null);
  const bottom = useRef<HTMLLIElement | null>(null);

  useEffect(() => {
    bottom.current?.scrollIntoView({ block: "end" });
  }, [props.entries]);

  const send = async (): Promise<void> => {
    const message = text.trim();
    if (message.length === 0 || pending) {
      return;
    }
    setPending(true);
    setSendError(null);
    try {
      const receipt = await window.coxswain.submit({ text: message });
      if (receipt.landed === "rejected") {
        setSendError(receipt.reason);
      } else {
        setText("");
      }
    } catch (error) {
      setSendError(error instanceof Error ? error.message : "Input could not be delivered");
    } finally {
      setPending(false);
    }
  };

  const submit = (event: SubmitEvent<HTMLFormElement>): void => {
    event.preventDefault();
    void send();
  };

  const keyDown = (event: KeyboardEvent<HTMLTextAreaElement>): void => {
    if (event.key === "Enter" && !event.shiftKey) {
      event.preventDefault();
      void send();
    }
  };

  const running = props.agentView.status.kind === "running";
  return (
    <section className="flex min-w-0 flex-1 flex-col border-r border-white/5">
      <ol className="scrollfade min-h-0 flex-1 space-y-5 overflow-y-auto px-6 py-5">
        {props.entries.length === 0 ? (
          <li className="flex h-full min-h-48 items-center justify-center text-center">
            <div className="max-w-sm space-y-2">
              <p className="text-sm text-zinc-400">Speak to the agent to start the run.</p>
              <p className="text-xs leading-5 text-zinc-600">
                This conversation contains only your inputs and replies the agent deliberately sends through <span className="font-mono text-zinc-500">say</span>. Raw output stays in Activity.
              </p>
            </div>
          </li>
        ) : props.entries.map((entry) => <ConversationItem entry={entry} key={entry.id} />)}
        <li ref={bottom} />
      </ol>
      <form className="shrink-0 px-6 pb-5" onSubmit={submit}>
        <div className="overflow-hidden rounded-xl border border-white/10 bg-ink-850 focus-within:border-oar-700">
          <textarea
            aria-label="Speak to the agent"
            className="w-full resize-none bg-transparent px-4 pt-3 text-sm text-zinc-200 outline-none placeholder:text-zinc-600 disabled:opacity-60"
            data-role="composer"
            disabled={pending}
            onChange={(event) => {
              setText(event.target.value);
            }}
            onKeyDown={keyDown}
            placeholder="speak to the agent…"
            rows={2}
            value={text}
          />
          <div className="flex min-h-8 items-center px-4 pb-2.5">
            <span className={`text-[11px] ${running ? "text-amber-500/80" : "text-zinc-600"}`}>
              {running
                ? "turn in flight — this will steer, or queue if steering is refused"
                : "starts a new turn — agent replies arrive only via say"}
            </span>
            <button
              className="ml-auto rounded-md bg-oar-600 px-3 py-1.5 text-xs font-semibold text-ink-950 hover:bg-oar-500 disabled:opacity-40"
              data-action="send"
              disabled={pending || text.trim().length === 0}
              type="submit"
            >
              {pending ? "sending…" : "send"}
            </button>
          </div>
        </div>
        {sendError === null ? null : <p className="mt-2 text-xs text-rose-400/80">not delivered · {sendError}</p>}
      </form>
    </section>
  );
}
