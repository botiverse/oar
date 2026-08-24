import type { SessionEventView } from "../../../../shared/ipc.js";

export type ActivityRow =
  | {
      readonly kind: "delta";
      readonly deltaKind: "text" | "reasoning";
      readonly turnId: string;
      readonly firstSeq: number;
      readonly lastSeq: number;
      readonly startedAt: number;
      readonly lastAt: number;
      readonly text: string;
    }
  | { readonly kind: "event"; readonly event: SessionEventView };

function deltaOf(event: SessionEventView): { readonly kind: "text" | "reasoning"; readonly text: string } | null {
  if (event.kind === "text_delta") {
    return { kind: "text", text: event.text };
  }
  return event.kind === "reasoning" && event.content.kind === "text"
    ? { kind: "reasoning", text: event.content.text }
    : null;
}

export function activityRows(events: readonly SessionEventView[]): readonly ActivityRow[] {
  const rows: ActivityRow[] = [];
  for (const event of events) {
    const delta = deltaOf(event);
    if (delta !== null) {
      const previous = rows.at(-1);
      if (previous?.kind === "delta"
        && previous.deltaKind === delta.kind
        && previous.turnId === event.turnId) {
        rows[rows.length - 1] = {
          ...previous,
          lastSeq: event.seq,
          lastAt: event.receivedAt,
          text: `${previous.text}${delta.text}`,
        };
      } else {
        rows.push({
          kind: "delta",
          deltaKind: delta.kind,
          turnId: event.turnId,
          firstSeq: event.seq,
          lastSeq: event.seq,
          startedAt: event.receivedAt,
          lastAt: event.receivedAt,
          text: delta.text,
        });
      }
    } else {
      rows.push({ kind: "event", event });
    }
  }
  return rows;
}
