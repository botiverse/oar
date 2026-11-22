import type { InputImage, RequestRecord } from "../../contracts/session.js";
import type { LoadedImage } from "../../shared/input-images.js";
import type { JsonRecord } from "../../shared/json.js";

/** Bounds a session's native waits; tests shorten them. */
export interface FactorySessionTimings {
  /** How long an accepted abort waits for droid's end of that turn before the process is stopped. */
  readonly abortFallbackMs?: number;
  /** How long a completed turn or confirmed manual compaction waits for `droid.get_context_stats` before settling. */
  readonly contextReadTimeoutMs?: number;
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

export interface FrameQueue {
  readonly idle: boolean;
  drain(): Promise<void>;
  enqueue(run: () => Promise<void>): Promise<void>;
}

/** Serializes async frame-recording steps so notifications and exit wait on bounded reads. */
export function createFrameQueue(): FrameQueue {
  let tail: Promise<void> | null = null;
  return {
    get idle(): boolean { return tail === null; },
    async drain(): Promise<void> {
      for (let pending = tail; pending !== null; pending = tail) { await pending; }
    },
    async enqueue(run: () => Promise<void>): Promise<void> {
      const previous = tail ?? Promise.resolve();
      const { promise: done, resolve } = Promise.withResolvers<void>();
      tail = done;
      try {
        await previous;
        await run();
      } finally {
        if (tail === done) { tail = null; }
        resolve();
      }
    },
  };
}
