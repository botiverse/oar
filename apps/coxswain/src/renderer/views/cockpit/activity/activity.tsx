import { useEffect, useMemo, useRef, useState } from "react";
import type {
  AgentViewUpdate,
  SessionEventView,
  TurnOutcomeView,
} from "../../../../shared/ipc.js";
import {
  friendlyActivityRows,
  type FriendlyActivityRow,
} from "./activity-model.js";
import {
  activityWidthLimit,
  clampActivityWidth,
  DEFAULT_ACTIVITY_WIDTH,
  draggedActivityWidth,
  MAX_ACTIVITY_WIDTH,
  MIN_ACTIVITY_WIDTH,
} from "./activity-size.js";

type ActivityView = "friendly" | "raw";
type PhaseRow = Extract<FriendlyActivityRow, { readonly kind: "phase" }>;
type ToolRow = Extract<FriendlyActivityRow, { readonly kind: "tool" }>;
type TurnRow = Extract<FriendlyActivityRow, { readonly kind: "turn" }>;

function shortId(value: string): string {
  return value.slice(0, 8);
}

function compactText(value: string, limit = 76): string {
  const compact = value.replaceAll(/\s+/gu, " ").trim();
  return compact.length > limit ? `${compact.slice(0, limit - 1)}…` : compact;
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

function rawDetail(event: SessionEventView): string | null {
  switch (event.kind) {
    case "turn_started":
      return shortId(event.turnId);
    case "reasoning":
      return event.content.kind === "text"
        ? compactText(event.content.text)
        : event.content.kind;
    case "text_delta":
      return compactText(event.text);
    case "tool_call_started":
      return compactText([
        event.tool,
        shortId(event.callId),
        event.input,
      ].filter((value) => value !== undefined).join(" · "));
    case "tool_call_ended":
      return compactText([
        shortId(event.callId),
        event.output,
      ].filter((value) => value !== undefined).join(" · "));
    case "turn_ended":
      return outcomeText(event.outcome);
  }
  throw new Error("Unknown session event");
}

function rawTone(event: SessionEventView): string {
  if (event.kind === "tool_call_started" || event.kind === "tool_call_ended") {
    return "text-sky-400/75";
  }
  if (event.kind === "turn_ended" && event.outcome.kind === "failed") {
    return "text-rose-400/75";
  }
  if (event.kind === "text_delta") {
    return "text-zinc-400";
  }
  return "text-zinc-500";
}

function RawEventRow({ event }: { readonly event: SessionEventView }): React.JSX.Element {
  const detail = rawDetail(event);
  return (
    <li className={rawTone(event)}>
      <details>
        <summary className="cursor-pointer" title={detail ?? event.kind}>
          <span className="text-zinc-600">{event.seq}</span> · {event.kind}
          {detail === null || detail.length === 0 ? null : (
            <span className="text-zinc-600"> · {detail}</span>
          )}
        </summary>
        <pre className="ml-4 mt-1 whitespace-pre-wrap break-words border-l border-white/5 pl-3 text-[10.5px] leading-4 text-zinc-500">
          {JSON.stringify(event, null, 2)}
        </pre>
      </details>
    </li>
  );
}

function ToolGlyph({ kind }: { readonly kind: ToolRow["actionKind"] }): React.JSX.Element {
  const common = {
    "aria-hidden": true,
    className: "size-3.5",
    fill: "none",
    stroke: "currentColor",
    strokeLinecap: "round" as const,
    strokeLinejoin: "round" as const,
    strokeWidth: 1.7,
    viewBox: "0 0 16 16",
  };
  switch (kind) {
    case "run_command":
      return (
        <svg {...common}>
          <path d="m3 4 3.5 4L3 12M8 12h5" />
        </svg>
      );
    case "read_file":
      return (
        <svg {...common}>
          <path d="M4 2.5h5l3 3V14H4zM9 2.5v3h3M6 9h4M6 11.5h3" />
        </svg>
      );
    case "edit_file":
      return (
        <svg {...common}>
          <path d="m3 11.5-.5 2 2-.5 7.8-7.8-1.5-1.5zM9.8 4.7l1.5 1.5" />
        </svg>
      );
    case "search":
      return (
        <svg {...common}>
          <circle cx="7" cy="7" r="3.5" />
          <path d="m9.7 9.7 3.1 3.1" />
        </svg>
      );
    case "web":
      return (
        <svg {...common}>
          <circle cx="8" cy="8" r="5.5" />
          <path d="M2.8 8h10.4M8 2.5c1.7 1.6 2.4 3.4 2.4 5.5S9.7 11.9 8 13.5C6.3 11.9 5.6 10.1 5.6 8S6.3 4.1 8 2.5" />
        </svg>
      );
    case "mcp":
    case "other":
      return (
        <svg {...common}>
          <rect height="4" rx="1" width="4" x="2.5" y="2.5" />
          <rect height="4" rx="1" width="4" x="9.5" y="9.5" />
          <path d="M6.5 4.5h2a3 3 0 0 1 3 3v2M9.5 11.5h-2a3 3 0 0 1-3-3v-2" />
        </svg>
      );
  }
  throw new Error("Unknown tool action kind");
}

function ToolActivityRow({ row }: { readonly row: ToolRow }): React.JSX.Element {
  const tone = row.state === "failed"
    ? "text-rose-400"
    : row.state === "running"
      ? "text-sky-400"
      : "text-zinc-400";
  const iconSurface = row.state === "failed"
    ? "border-rose-500/20 bg-rose-500/8"
    : row.state === "running"
      ? "border-sky-500/20 bg-sky-500/8"
      : "border-white/8 bg-white/[0.025]";
  return (
    <li className="flex gap-2.5 py-1.5">
      <span className={`relative mt-0.5 flex size-7 shrink-0 items-center justify-center rounded-lg border ${iconSurface} ${tone}`}>
        <ToolGlyph kind={row.actionKind} />
        {row.state === "running" ? (
          <span className="absolute -right-0.5 -top-0.5 size-1.5 animate-pulse rounded-full bg-sky-400 ring-2 ring-ink-900" />
        ) : null}
      </span>
      <div className="min-w-0 flex-1">
        <div className="flex items-baseline gap-2">
          <span className={`text-xs font-medium ${tone}`}>{row.label}</span>
          <span className="ml-auto shrink-0 font-mono text-[10px] text-zinc-600">
            {row.state === "running" ? "live" : duration(row.startedAt, row.lastAt)}
          </span>
        </div>
        {row.detail === undefined ? null : (
          <div className="mt-0.5 truncate font-mono text-[10.5px] leading-4 text-zinc-500" title={row.detail}>
            {row.detail}
          </div>
        )}
        {row.output === undefined ? null : (
          <details className="mt-0.5 font-mono text-[10px] text-zinc-600">
            <summary className="cursor-pointer select-none">result</summary>
            <pre className="mt-1 max-h-28 overflow-auto whitespace-pre-wrap break-words border-l border-white/5 pl-2 text-zinc-500">
              {row.output}
            </pre>
          </details>
        )}
      </div>
    </li>
  );
}

function PhaseActivityRow({ row }: { readonly row: PhaseRow }): React.JSX.Element {
  const label = row.phase === "thinking" ? "Thinking" : "Generated output";
  return (
    <li className="flex gap-2.5 py-1.5 text-zinc-500">
      <span className="mt-0.5 flex size-7 shrink-0 items-center justify-center rounded-lg border border-white/6 bg-white/[0.02]">
        {row.phase === "thinking" ? (
          <svg aria-hidden="true" className="size-3.5" fill="none" stroke="currentColor" strokeLinecap="round" strokeWidth="1.7" viewBox="0 0 16 16">
            <path d="M5 5.5h6M4 8h8M6 10.5h4" />
          </svg>
        ) : (
          <svg aria-hidden="true" className="size-3.5" fill="none" stroke="currentColor" strokeLinecap="round" strokeLinejoin="round" strokeWidth="1.7" viewBox="0 0 16 16">
            <path d="M3 3.5h10v7H7l-3 2v-2H3z" />
          </svg>
        )}
      </span>
      <div className="min-w-0 flex-1">
        <div className="flex items-baseline gap-2">
          <span className="text-xs font-medium text-zinc-400">{label}</span>
          <span className="ml-auto shrink-0 font-mono text-[10px] text-zinc-600">
            {duration(row.startedAt, row.lastAt)}
          </span>
        </div>
        {row.text.length === 0 ? null : (
          <div className="mt-0.5 truncate text-[11px] leading-4 text-zinc-600" title={row.text}>
            {compactText(row.text)}
          </div>
        )}
      </div>
    </li>
  );
}

function turnLabel(row: TurnRow): string {
  switch (row.state) {
    case "started":
      return "Turn started";
    case "completed":
      return "Turn completed";
    case "aborted":
      return "Turn stopped";
    case "failed":
      return "Turn failed";
  }
  throw new Error("Unknown turn state");
}

function TurnActivityRow({ row }: { readonly row: TurnRow }): React.JSX.Element {
  const failed = row.state === "failed";
  return (
    <li className={`flex items-center gap-2 py-1 text-[10px] uppercase tracking-wide ${failed ? "text-rose-400/70" : "text-zinc-600"}`}>
      <span className={`h-px w-3 shrink-0 ${failed ? "bg-rose-500/20" : "bg-white/5"}`} />
      <span>{turnLabel(row)}</span>
      <span className="font-mono normal-case tracking-normal text-zinc-700">{shortId(row.turnId)}</span>
      <span className={`h-px min-w-3 flex-1 ${failed ? "bg-rose-500/20" : "bg-white/5"}`} />
      {row.outcome?.kind === "failed" ? (
        <span className="sr-only">{row.outcome.failure}: {row.outcome.reason}</span>
      ) : null}
    </li>
  );
}

function FriendlyRow({ row }: { readonly row: FriendlyActivityRow }): React.JSX.Element {
  switch (row.kind) {
    case "tool":
      return <ToolActivityRow row={row} />;
    case "phase":
      return <PhaseActivityRow row={row} />;
    case "turn":
      return <TurnActivityRow row={row} />;
  }
  throw new Error("Unknown friendly Activity row");
}

function ViewSwitch(props: {
  readonly view: ActivityView;
  readonly onChange: (view: ActivityView) => void;
}): React.JSX.Element {
  return (
    <div aria-label="Activity view" className="ml-3 flex rounded-md bg-white/[0.035] p-0.5 normal-case tracking-normal" role="tablist">
      {(["friendly", "raw"] as const).map((view) => (
        <button
          aria-selected={props.view === view}
          className={`rounded px-2 py-0.5 text-[10px] font-medium transition-colors ${
            props.view === view
              ? "bg-ink-700 text-zinc-300"
              : "text-zinc-600 hover:text-zinc-400"
          }`}
          key={view}
          onClick={() => {
            props.onChange(view);
          }}
          role="tab"
          type="button"
        >
          {view === "friendly" ? "Friendly" : "Raw"}
        </button>
      ))}
    </div>
  );
}

export function Activity(props: {
  readonly events: readonly SessionEventView[];
  readonly agentView: AgentViewUpdate;
  readonly runtimeId: string;
  /** Compact lane column mode used by the Regatta view. */
  readonly compact?: boolean;
}): React.JSX.Element {
  const rows = useMemo(
    () => friendlyActivityRows(props.runtimeId, props.events),
    [props.events, props.runtimeId],
  );
  const bottom = useRef<HTMLLIElement | null>(null);
  const panel = useRef<HTMLElement | null>(null);
  const drag = useRef<{
    readonly pointerId: number;
    readonly startingClientX: number;
    readonly startingWidth: number;
    readonly containerWidth: number;
    readonly previousCursor: string;
    readonly previousUserSelect: string;
  } | null>(null);
  const [view, setView] = useState<ActivityView>("friendly");
  const [width, setWidth] = useState(DEFAULT_ACTIVITY_WIDTH);
  const lastSequence = props.events.at(-1)?.seq;

  useEffect(() => {
    bottom.current?.scrollIntoView({ block: "end" });
  }, [lastSequence, rows, view]);

  useEffect(() => {
    const fitToWindow = (): void => {
      const containerWidth = panel.current?.parentElement?.clientWidth;
      if (containerWidth !== undefined) {
        setWidth((current) => clampActivityWidth(current, containerWidth));
      }
    };
    fitToWindow();
    window.addEventListener("resize", fitToWindow);
    return (): void => {
      window.removeEventListener("resize", fitToWindow);
      const current = drag.current;
      if (current !== null) {
        document.body.style.cursor = current.previousCursor;
        document.body.style.userSelect = current.previousUserSelect;
        drag.current = null;
      }
    };
  }, []);

  const finishDrag = (target: HTMLDivElement, pointerId: number): void => {
    const current = drag.current;
    if (current === null || current.pointerId !== pointerId) {
      return;
    }
    if (target.hasPointerCapture(pointerId)) {
      target.releasePointerCapture(pointerId);
    }
    document.body.style.cursor = current.previousCursor;
    document.body.style.userSelect = current.previousUserSelect;
    drag.current = null;
  };

  const isEmpty = view === "friendly" ? rows.length === 0 : props.events.length === 0;

  return (
    <aside
      className="relative flex shrink-0 flex-col bg-ink-900/60"
      data-compact={props.compact === true ? "true" : undefined}
      ref={panel}
      style={{ width: props.compact === true ? 220 : width }}
    >
      {props.compact === true ? null : <div
        aria-label="Resize Activity panel"
        aria-orientation="vertical"
        aria-valuemax={MAX_ACTIVITY_WIDTH}
        aria-valuemin={MIN_ACTIVITY_WIDTH}
        aria-valuenow={width}
        className="group absolute inset-y-0 left-0 z-10 w-2 -translate-x-1 cursor-col-resize touch-none outline-none"
        onKeyDown={(event) => {
          const containerWidth = event.currentTarget.parentElement?.parentElement?.clientWidth;
          if (containerWidth === undefined) {
            return;
          }
          switch (event.key) {
            case "ArrowLeft":
              setWidth((current) => clampActivityWidth(current + 16, containerWidth));
              break;
            case "ArrowRight":
              setWidth((current) => clampActivityWidth(current - 16, containerWidth));
              break;
            case "Home":
              setWidth(MIN_ACTIVITY_WIDTH);
              break;
            case "End":
              setWidth(activityWidthLimit(containerWidth));
              break;
            default:
              return;
          }
          event.preventDefault();
        }}
        onPointerCancel={(event) => {
          finishDrag(event.currentTarget, event.pointerId);
        }}
        onPointerDown={(event) => {
          if (!event.isPrimary || event.button !== 0) {
            return;
          }
          const containerWidth = event.currentTarget.parentElement?.parentElement?.clientWidth;
          if (containerWidth === undefined) {
            return;
          }
          drag.current = {
            pointerId: event.pointerId,
            startingClientX: event.clientX,
            startingWidth: width,
            containerWidth,
            previousCursor: document.body.style.cursor,
            previousUserSelect: document.body.style.userSelect,
          };
          event.currentTarget.setPointerCapture(event.pointerId);
          document.body.style.cursor = "col-resize";
          document.body.style.userSelect = "none";
        }}
        onPointerMove={(event) => {
          const current = drag.current;
          if (current === null || current.pointerId !== event.pointerId) {
            return;
          }
          setWidth(draggedActivityWidth(
            current.startingWidth,
            current.startingClientX,
            event.clientX,
            current.containerWidth,
          ));
        }}
        onPointerUp={(event) => {
          finishDrag(event.currentTarget, event.pointerId);
        }}
        role="separator"
        tabIndex={0}
        title="Drag to resize Activity"
      >
        <span className="absolute inset-y-0 left-1/2 w-px -translate-x-1/2 bg-white/5 transition-colors group-hover:bg-oar-500/50 group-focus:bg-oar-500/50" />
      </div>}
      <div className="flex h-9 shrink-0 items-center border-b border-white/5 px-4 text-xs font-medium uppercase tracking-wide text-zinc-500">
        Activity
        <ViewSwitch onChange={setView} view={view} />
        <span className={`ml-auto font-mono normal-case text-zinc-600 ${props.compact === true ? "hidden" : ""}`}>
          {lastSequence === undefined ? "waiting" : `seq ${lastSequence}`}
        </span>
      </div>
      <ol className={`scrollfade min-h-0 flex-1 overflow-y-auto px-4 py-3 ${
        view === "raw" ? "space-y-0.5 font-mono text-[11px] leading-5" : "space-y-0.5"
      }`}>
        {isEmpty ? (
          <li className="py-3 text-xs text-zinc-600">
            {view === "friendly"
              ? "Actions will appear here as the agent works."
              : "Raw OAR events will appear here one-for-one."}
          </li>
        ) : view === "friendly" ? rows.map((row) => (
          <FriendlyRow
            key={row.kind === "tool"
              ? `tool-${row.turnId}-${row.callId}`
              : row.kind === "phase"
                ? `phase-${row.turnId}-${row.firstSeq}`
                : `turn-${row.turnId}-${row.seq}`}
            row={row}
          />
        )) : props.events.map((event) => (
          <RawEventRow event={event} key={`raw-${event.seq}`} />
        ))}
        <li className={`flex items-center gap-1.5 pt-2 text-[10px] ${
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
