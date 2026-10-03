/** One part of a tool result: text, an image (base64 `data` and its media type), or a block OAR does not recognize, kept whole. */
export type ToolOutputPart =
  | { readonly type: "text"; readonly text: string }
  | { readonly type: "image"; readonly mediaType: string; readonly data: string }
  | { readonly type: "other"; readonly value: unknown };
