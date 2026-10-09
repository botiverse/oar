/** One part of a tool result: text, an image (base64 `data` and its media type), or a block OAR does not recognize, kept whole. */
export type ToolOutputPart =
  | { readonly type: "text"; readonly text: string }
  | { readonly type: "image"; readonly mediaType: string; readonly data: string }
  | { readonly type: "other"; readonly value: unknown };

/** Partial output reported by the runtime for this call. Snapshots replace; deltas append. Claude streams none; Cursor's independent shell output has no call id and stays in native frames. */
export interface ToolCallProgress {
  readonly kind: "tool_call_progress";
  readonly callId: string;
  /** The whole current preview, replacing earlier output (Pi, ACP and Pi Durable's retained window). An empty string clears it. */
  readonly output?: string;
  /** Append this chunk to the preview (Codex `item/commandExecution/outputDelta`). If both fields are present, replace with `output` first, then append this. */
  readonly outputDelta?: string;
}
