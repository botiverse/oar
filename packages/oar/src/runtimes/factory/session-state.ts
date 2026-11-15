import type { InputImage, RequestRecord } from "../../contracts/session.js";
import type { LoadedImage } from "../../shared/input-images.js";
import type { JsonRecord } from "../../shared/json.js";

/** Bounds a session's native waits; tests shorten them. */
export interface FactorySessionTimings {
  /** How long an accepted abort waits for droid's end of that turn before the process is stopped. */
  readonly abortFallbackMs?: number;
}

export interface Held {
  readonly inputId: string | undefined;
  readonly input: string;
  readonly images: readonly InputImage[] | undefined;
  readonly loaded: readonly LoadedImage[];
  readonly request: RequestRecord;
  accepted: boolean;
}

/** droid's image input: base64 with its media type. */
export function droidImages(images: readonly LoadedImage[]): JsonRecord {
  return images.length === 0 ? {} : { images: images.map(image => ({ type: "base64", data: image.data, mediaType: image.mediaType })) };
}
