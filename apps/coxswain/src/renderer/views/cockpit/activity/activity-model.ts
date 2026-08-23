import type { SessionEventView } from "../../../../shared/ipc.js";

export type ActivityRow =
  | {
      readonly kind: "delta";
      readonly deltaKind: "text_delta" | "thinking_delta";
      readonly turnId: string;
      readonly firstSeq: number;
      readonly lastSeq: number;
      readonly startedAt: number;
      readonly lastAt: number;
      readonly text: string;
    }
  | { readonly kind: "event"; readonly event: SessionEventView };

export function activityRows(events: readonly SessionEventView[]): readonly ActivityRow[] {
  const rows: ActivityRow[] = [];
  for (const event of events) {
    if (event.kind === "text_delta" || event.kind === "thinking_delta") {
      const previous = rows.at(-1);
      if (previous?.kind === "delta"
        && previous.deltaKind === event.kind
        && previous.turnId === event.turnId) {
        rows[rows.length - 1] = {
          ...previous,
          lastSeq: event.seq,
          lastAt: event.receivedAt,
          text: `${previous.text}${event.text}`,
        };
      } else {
        rows.push({
          kind: "delta",
          deltaKind: event.kind,
          turnId: event.turnId,
          firstSeq: event.seq,
          lastSeq: event.seq,
          startedAt: event.receivedAt,
          lastAt: event.receivedAt,
          text: event.text,
        });
      }
    } else {
      rows.push({ kind: "event", event });
    }
  }
  return rows;
}
