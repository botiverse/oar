import { useEffect, useRef, useState, type KeyboardEvent, type SubmitEvent } from "react";
import type {
  AgentViewUpdate,
  ConversationEntry,
  SubmitReceipt,
  TurnOutcomeView,
} from "../../../../shared/ipc.js";
import type { TurnUsageView, UsageWindowDeltaView } from "../../usage-helm/usage-model.js";

function percent(ratio: number): string {
  return `${(Math.abs(ratio) * 100).toFixed(1)}%`;
}

function signedPercent(ratio: number): string {
  return `${ratio >= 0 ? "+" : "−"}${percent(ratio)}`;
}

function clock(timestamp: number): string {
  return new Date(timestamp).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });
}

function windowMotion(window: UsageWindowDeltaView): string {
  if (window.deltaRatio === undefined) {
    return "baseline unavailable";
  }
  if (window.reset) {
    return `reset ${signedPercent(window.deltaRatio)}`;
  }
  if (window.deltaRatio === 0) {
    return "no movement";
  }
  const burn = window.burnRatePerMinute === undefined
    ? ""
    : ` · ${percent(window.burnRatePerMinute)}/min`;
  const projection = window.resetBeforeProjection
    ? " · resets before limit"
    : window.projectedLimitAt === undefined
      ? ""
      : ` · estimated limit ~${clock(window.projectedLimitAt)}`;
  return `${signedPercent(window.deltaRatio)}${burn}${projection}`;
}

function UsageMotion({ usage }: { readonly usage: TurnUsageView | undefined }): React.JSX.Element | null {
  if (usage === undefined) {
    return null;
  }
  if (usage.status !== "available") {
    return (
      <div
        className="mt-2 text-left font-mono text-[10px] text-zinc-600"
        data-usage-reason={usage.reason}
        data-usage-status={usage.status}
        data-usage-turn={usage.turnId}
      >
        usage · {usage.reason ?? usage.status.replaceAll("_", " ")}
      </div>
    );
  }
  return (
    <div
      className="mt-2 space-y-0.5 text-left font-mono text-[10px] text-zinc-600"
      data-usage-status="available"
      data-usage-turn={usage.turnId}
    >
      <div className="flex items-center gap-1.5 text-oar-600/80">
        <span aria-hidden="true">◌</span>
        <span>usage motion{usage.plan === undefined ? "" : ` · ${usage.plan}`}</span>
        {usage.rateLimited === true ? <span className="text-amber-500/80"> · rate limited</span> : null}
      </div>
      {usage.windows.length === 0 ? (
        <div className="pl-4">no usage windows reported</div>
      ) : usage.windows.map((window, index) => (
        <div
          className="flex gap-2 pl-4"
          data-usage-burn-rate={window.burnRatePerMinute?.toFixed(4)}
          data-usage-delta={window.deltaRatio?.toFixed(4)}
          data-usage-projection={window.projectedLimitAt === undefined ? undefined : "estimated"}
          data-usage-reset={window.reset ? "true" : "false"}
          data-usage-window={window.label}
          key={`${window.label}-${index}`}
        >
          <span className="max-w-[8rem] truncate text-zinc-600" title={window.label}>{window.label}</span>
          <span className={window.reset ? "text-amber-500/80" : "text-zinc-500"}>{windowMotion(window)}</span>
        </div>
      ))}
    </div>
  );
}

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

export function ConversationItem(props: {
  readonly entry: ConversationEntry;
  readonly usage?: TurnUsageView;
}): React.JSX.Element {
  const { entry } = props;
  if (entry.kind === "outcome") {
    const outcome = outcomeCopy(entry.outcome);
    return (
      <li className={`text-center text-[11px] ${outcome.failure ? "text-rose-400/70" : "text-zinc-600"}`} data-entry-kind="outcome">
        <div>— {outcome.text} —</div>
        <UsageMotion usage={props.usage} />
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

export interface ConversationComposerProps {
  readonly onSubmit: (text: string) => Promise<SubmitReceipt>;
  readonly disabled?: boolean;
  readonly agentView?: AgentViewUpdate;
}

/**
 * The ordinary one-lane composer. Regatta reuses the same interaction shape
 * with a broadcast callback, keeping the lane conversation itself read-only.
 */
export function ConversationComposer(props: ConversationComposerProps): React.JSX.Element {
  const [text, setText] = useState("");
  const [pending, setPending] = useState(false);
  const [sendError, setSendError] = useState<string | null>(null);

  const send = async (): Promise<void> => {
    const message = text.trim();
    if (message.length === 0 || pending) {
      return;
    }
    setPending(true);
    setSendError(null);
    try {
      const receipt = await props.onSubmit(message);
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

  const running = props.agentView?.status.kind === "running";
  return (
    <form className="shrink-0 px-6 pb-5" onSubmit={submit}>
      <div className="overflow-hidden rounded-xl border border-white/10 bg-ink-850 focus-within:border-oar-700">
        <textarea
          aria-label="Speak to the agent"
          className="w-full resize-none bg-transparent px-4 pt-3 text-sm text-zinc-200 outline-none placeholder:text-zinc-600 disabled:opacity-60"
          data-role="composer"
          disabled={pending || props.disabled === true}
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
            disabled={pending || props.disabled === true || text.trim().length === 0}
            type="submit"
          >
            {pending ? "sending…" : "send"}
          </button>
        </div>
      </div>
      {sendError === null ? null : <p className="mt-2 text-xs text-rose-400/80">not delivered · {sendError}</p>}
    </form>
  );
}

export function Conversation(props: {
  readonly entries: readonly ConversationEntry[];
  readonly agentView: AgentViewUpdate;
  /** Omit to use the normal un-targeted IPC submit path. */
  readonly onSubmit?: (text: string) => Promise<SubmitReceipt>;
  /** Regatta uses the lane timeline as a read-only column. */
  readonly showComposer?: boolean;
  /** Per-turn account usage projections for outcome rows. */
  readonly usage?: ReadonlyMap<string, TurnUsageView>;
}): React.JSX.Element {
  const bottom = useRef<HTMLLIElement | null>(null);

  useEffect(() => {
    bottom.current?.scrollIntoView({ block: "end" });
  }, [props.entries]);

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
        ) : props.entries.map((entry) => {
          const turnUsage = entry.kind === "outcome" ? props.usage?.get(entry.turnId) : undefined;
          return <ConversationItem
            entry={entry}
            key={entry.id}
            {...(turnUsage === undefined ? {} : { usage: turnUsage })}
          />;
        })}
        <li ref={bottom} />
      </ol>
      {props.showComposer === false ? null : (
        <ConversationComposer
          agentView={props.agentView}
          onSubmit={props.onSubmit ?? (async (text: string): Promise<SubmitReceipt> =>
            window.coxswain.submit({ text }))}
        />
      )}
    </section>
  );
}
