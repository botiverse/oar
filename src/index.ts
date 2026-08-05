export type RuntimeEvent =
  | { kind: "text"; text: string }
  | { kind: "tool_call"; name: string }
  | { kind: "turn_end" };

export function describe(event: RuntimeEvent): string {
  switch (event.kind) {
    case "text":
      return `text(${String(event.text.length)})`;
    case "tool_call":
      return `tool_call(${event.name})`;
    case "turn_end":
      return "turn_end";
  }
}
