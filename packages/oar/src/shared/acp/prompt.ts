/* oxlint-disable typescript/promise-function-async -- The send callback returns the SDK promise without inserting another await. */
import { pathToFileURL } from "node:url";
import type { LoadedImage } from "../input-images.js";
import { asRecord, type JsonRecord } from "../json.js";
import { methods, withAcpDeadline, type AcpProcess } from "./process.js";

/** The agent advertised image prompts in `initialize` (`agentCapabilities.promptCapabilities.image`). */
export function acpTakesImages(initialized: JsonRecord): boolean {
  return asRecord(asRecord(initialized.agentCapabilities)?.promptCapabilities)?.image === true;
}

/** One input as ACP ContentBlocks: the images (each naming its file as `uri`), then any nonempty text. */
export function acpPrompt(input: string, images: readonly LoadedImage[]): JsonRecord[] {
  return [
    ...images.map((image) => ({ type: "image", mimeType: image.mediaType, data: image.data, uri: pathToFileURL(image.path).href })),
    ...(input === "" ? [] : [{ type: "text", text: input }]),
  ];
}
export async function promptAcp(
  process: AcpProcess,
  sessionId: string,
  prompt: readonly JsonRecord[],
  extraParams: JsonRecord = {},
  dispatch: { readonly beforeSend?: () => void; readonly sent?: () => void; readonly received?: () => void } = {},
): Promise<JsonRecord> {
  const method = methods.agent.session.prompt;
  let response: unknown = undefined;
  try {
    response = await withAcpDeadline(
      process,
      method,
      null,
      (requestOptions) => {
        // This is after the transport's spawn wait, immediately before SDK dispatch.
        dispatch.beforeSend?.();
        const pending = process.connection.agent.request(method, { sessionId, prompt, ...extraParams }, requestOptions);
        dispatch.sent?.();
        return pending;
      },
    );
  } finally { dispatch.received?.(); }
  // The SDK's built-in session router yields once before OAR's update handler.
  await new Promise<void>((resolve) => {
    setImmediate(resolve);
  });
  const result = asRecord(response);
  if (result === null) { throw new TypeError(`ACP ${method} returned a non-object response`); }
  return result;
}

