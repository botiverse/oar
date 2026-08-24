import { useEffect, useMemo, useRef } from "react";
import type { AgentViewUpdate, SessionEventView, TurnOutcomeView } from "../../../../shared/ipc.js";
import { activityRows, type ActivityRow } from "./activity-model.js";

function shortId(value: string): string {
  return value.slice(0, 8);
}

function compactText(value: string): string {
  const compact = value.replaceAll(/\s+/gu, " ").trim();
  return compact.length > 58 ? `${compact.slice(0, 57)}…` : compact;
}

function duration(startedAt: number, lastAt: number): string {
  const elapsed = Math.max(0, lastAt - startedAt);
  return elapsed < 1000 ? `${elapsed}ms` : `${(elapsed / 1000).toFixed(1)}s`;
}

function outcomeText(outcome: TurnOutcomeView): string {
  switch (outcome.kind) {
    case "completed":
      return "completed";
    case "aborted":
      return "aborted";
    case "failed":
      return `failed · ${outcome.failure} · ${compactText(outcome.reason)}`;
  }
  throw new Error("Unknown turn outcome");
}

function DeltaRow({ row }: { readonly row: Extract<ActivityRow, { readonly kind: "delta" }> }): React.JSX.Element {
  const sequence = row.firstSeq === row.lastSeq
    ? String(row.lastSeq)
    : `${row.firstSeq}–${row.lastSeq}`;
  if (row.deltaKind === "reasoning") {
    return (
      <li className="text-zinc-500">
        <details>
          <summary className="cursor-pointer" title={row.text}>
            <span className="text-zinc-600">{sequence}</span> · reasoning
            <span className="text-zinc-600"> · {duration(row.startedAt, row.lastAt)}</span>
            {row.text.length === 0 ? null : <span className="text-zinc-500"> · “{compactText(row.text)}”</span>}
          </summary>
          <pre className="ml-4 whitespace-pre-wrap break-words text-zinc-400">{row.text}</pre>
        </details>
      </li>
    );
  }
  return (
    <li className="text-zinc-400" title={row.text}>
      <span className="text-zinc-600">{sequence}</span> · text
      <span className="text-zinc-600"> · “{compactText(row.text)}”</span>
    </li>
  );
}

function EventRow({ event }: { readonly event: SessionEventView }): React.JSX.Element {
  switch (event.kind) {
    case "turn_started":
      return (
        <li className="text-zinc-500">
          <span className="text-zinc-600">{event.seq}</span> · turn_started <span className="text-zinc-600">{shortId(event.turnId)}</span>
        </li>
      );
    case "tool_call_started":
      return (
        <li className="text-sky-400/80">
          <details>
            <summary className={event.input === undefined ? "list-none" : "cursor-pointer"}>
              <span className="text-zinc-600">{event.seq}</span> · tool_call_started
              <span className="text-zinc-500"> · {event.tool}</span>
              <span className="text-zinc-600"> · {shortId(event.callId)}</span>
              {event.input === undefined ? null : <span className="text-sky-400/70"> · {compactText(event.input)}</span>}
            </summary>
            {event.input === undefined ? null : (
              <pre className="ml-4 whitespace-pre-wrap break-words text-zinc-400">{event.input}</pre>
            )}
          </details>
        </li>
      );
    case "tool_call_ended":
      return (
        <li className="text-sky-400/60">
          <details>
            <summary className={event.output === undefined ? "list-none" : "cursor-pointer"}>
              <span className="text-zinc-600">{event.seq}</span> · tool_call_ended
              <span className="text-zinc-600"> · {shortId(event.callId)}</span>
              {event.output === undefined ? null : <span> · {compactText(event.output)}</span>}
            </summary>
            {event.output === undefined ? null : (
              <pre className="ml-4 whitespace-pre-wrap break-words text-zinc-400">{event.output}</pre>
            )}
          </details>
        </li>
      );
    case "turn_ended":
      return (
        <li className={event.outcome.kind === "failed" ? "text-rose-400/70" : "text-zinc-500"}>
          <span className="text-zinc-600">{event.seq}</span> · turn_ended
          <span className="text-zinc-600"> · {outcomeText(event.outcome)}</span>
        </li>
      );
    case "text_delta":
      return <li />;
    case "reasoning":
      if (event.content.kind === "text") {
        return <li />;
      }
      return (
        <li className="text-zinc-500">
          <span className="text-zinc-600">{event.seq}</span> · reasoning
          <span className="text-zinc-600"> · {event.content.kind}</span>
        </li>
      );
  }
  throw new Error("Unknown session event");
}

export function Activity(props: {
  readonly events: readonly SessionEventView[];
  readonly agentView: AgentViewUpdate;
}): React.JSX.Element {
  const rows = useMemo(() => activityRows(props.events), [props.events]);
  const bottom = useRef<HTMLLIElement | null>(null);
  const lastSequence = props.events.at(-1)?.seq;

  useEffect(() => {
    bottom.current?.scrollIntoView({ block: "end" });
  }, [rows]);

  return (
    <aside className="flex w-[380px] shrink-0 flex-col bg-ink-900/60">
      <div className="flex h-9 shrink-0 items-center border-b border-white/5 px-4 text-xs font-medium uppercase tracking-wide text-zinc-500">
        Activity
        <span className="ml-auto font-mono normal-case text-zinc-600">
          {lastSequence === undefined ? "waiting" : `seq ${lastSequence}`}
        </span>
      </div>
      <ol className="scrollfade min-h-0 flex-1 space-y-0.5 overflow-y-auto px-4 py-3 font-mono text-[11.5px] leading-5">
        {rows.length === 0 ? (
          <li className="py-3 text-zinc-600">events will appear here verbatim; consecutive deltas are grouped for reading</li>
        ) : rows.map((row) => row.kind === "delta" ? (
          <DeltaRow key={`delta-${row.firstSeq}-${row.lastSeq}`} row={row} />
        ) : (
          <EventRow event={row.event} key={`event-${row.event.seq}`} />
        ))}
        <li className={`flex items-center gap-1.5 pt-2 ${
          props.agentView.status.kind === "running" ? "text-oar-600" : "text-zinc-600"
        }`} ref={bottom}>
          <span className={`size-1 rounded-full ${
            props.agentView.status.kind === "running" ? "animate-pulse bg-oar-500" : "bg-ink-600"
          }`} />
          {props.agentView.status.kind === "running" ? "live" : "idle"}
        </li>
      </ol>
    </aside>
  );
}
