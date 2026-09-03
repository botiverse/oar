import {
  openVoyage,
  type SessionEvent,
  type SubmissionVia,
  type VoyageRecorder as OarVoyageRecorder,
} from "@botiverse/oar";
import { randomUUID } from "node:crypto";
import { mkdir, writeFile } from "node:fs/promises";
import { basename, join, resolve as resolvePath } from "node:path";

/** Options needed to open the app-owned capture for one session lane. */
export interface VoyageRecorderOptions {
  readonly laneId: string;
  readonly sessionId: string;
  readonly runtimeId: string;
  readonly cwd: string;
  readonly model?: string;
  readonly directory: string;
  /** Clock seam for deterministic host tests; defaults to Date.now. */
  readonly now?: () => number;
  readonly onError?: (error: unknown) => void;
}

export interface VoyageSubmissionTicket {
  /** Complete the reserved submission after the OAR operation resolves. */
  complete(result: { readonly via: SubmissionVia }): void;
}

function safeFilePart(value: string): string {
  const normalized = value.trim().replaceAll(/[^a-zA-Z0-9._-]+/gu, "-");
  return normalized.length === 0 ? "lane" : normalized.slice(0, 80);
}

interface PendingSubmission {
  readonly text: string;
  readonly viaHint: SubmissionVia;
  via: SubmissionVia | null;
  complete: boolean;
}

/**
 * Coxswain's small lifecycle adapter around OAR's public voyage recorder.
 *
 * The public recorder writes synchronously and intentionally has only four
 * record kinds. The adapter adds two app concerns: creating a per-lane file,
 * and buffering events while an asynchronous steer/queue result is resolved.
 * That buffer is what keeps a synchronous runtime event after `prompt` or
 * during `steerOrQueue` behind its corresponding submission line.
 */
export class CoxswainVoyageRecorder {
  readonly #path: string;
  readonly #writer: OarVoyageRecorder;
  readonly #onError: (error: unknown) => void;
  readonly #pendingSubmissions: PendingSubmission[] = [];
  readonly #deferredEvents: SessionEvent[] = [];
  #failed = false;
  #closed = false;

  private constructor(
    path: string,
    writer: OarVoyageRecorder,
    onError: (error: unknown) => void,
  ) {
    this.#path = path;
    this.#writer = writer;
    this.#onError = onError;
  }

  static async create(options: VoyageRecorderOptions): Promise<CoxswainVoyageRecorder> {
    const directory = resolvePath(options.directory);
    await mkdir(directory, { recursive: true, mode: 0o700 });
    const startedAt = (options.now ?? ((): number => Date.now()))();

    // openVoyage deliberately owns the format and its write semantics. Create
    // the file first so it has a private mode, then let the public recorder
    // open it without risking a name collision between concurrent lanes.
    const path = join(
      directory,
      `${new Date(startedAt).toISOString().replaceAll(/[^0-9TZ-]/gu, "")}-${safeFilePart(options.laneId)}-${safeFilePart(options.sessionId)}-${randomUUID()}.jsonl`,
    );
    await writeFile(path, "", { encoding: "utf8", mode: 0o600, flag: "wx" });
    const writer = ((): OarVoyageRecorder => {
      try {
        return openVoyage(path, {
          runtime: options.runtimeId,
          ...(options.model === undefined ? {} : { model: options.model }),
          cwd: options.cwd,
          sessionId: options.sessionId,
          startedAt,
          recorder: "coxswain",
        });
      } catch (error) {
        // Leave a failed file as evidence of the attempted capture; report the
        // error to the host, which can decide how to surface it to the renderer.
        options.onError?.(error);
        throw error;
      }
    })();
    return new CoxswainVoyageRecorder(
      path,
      writer,
      options.onError ?? ((): void => {}),
    );
  }

  get path(): string {
    return this.#path;
  }

  get filename(): string {
    return basename(this.#path);
  }

  #reportFailure(error: unknown): void {
    if (this.#failed) {
      return;
    }
    this.#failed = true;
    try {
      this.#onError(error);
    } catch {
      // A diagnostics callback must never change session behavior.
    }
  }

  #drain(): void {
    if (this.#closed || this.#failed) {
      return;
    }
    while (this.#pendingSubmissions.length > 0) {
      const first = this.#pendingSubmissions.at(0);
      if (first === undefined || first.via === null) {
        break;
      }
      this.#pendingSubmissions.splice(0, 1);
      try {
        this.#writer.submission(first.via, first.text);
      } catch (error) {
        this.#reportFailure(error);
        return;
      }
    }
    if (this.#pendingSubmissions.length > 0) {
      return;
    }
    while (this.#deferredEvents.length > 0) {
      const event = this.#deferredEvents.shift();
      if (event === undefined) {
        break;
      }
      try {
        this.#writer.event(event);
      } catch (error) {
        this.#reportFailure(error);
        return;
      }
    }
  }

  /**
   * Reserve a submission before invoking OAR. Events observed while the
   * operation is pending are held until `complete` writes the submission.
   */
  beginSubmission(input: {
    readonly text: string;
    /** The attempted operation, used only if a close races its receipt. */
    readonly viaHint: SubmissionVia;
  }): VoyageSubmissionTicket {
    if (this.#closed) {
      return { complete: (): void => {} };
    }
    const pending: PendingSubmission = {
      text: input.text,
      viaHint: input.viaHint,
      via: null,
      complete: false,
    };
    this.#pendingSubmissions.push(pending);
    return {
      complete: (result): void => {
        if (pending.complete) {
          return;
        }
        pending.complete = true;
        pending.via = result.via;
        this.#drain();
      },
    };
  }

  /** Record one untouched public SessionEvent. */
  recordEvent(event: SessionEvent): void {
    if (this.#pendingSubmissions.length > 0) {
      try {
        this.#deferredEvents.push(structuredClone(event));
      } catch (error) {
        // A malformed/non-cloneable event must not make the recorder observer
        // break the session's other observers. Report it as a capture failure.
        this.#reportFailure(error);
      }
      return;
    }
    if (this.#closed || this.#failed) {
      return;
    }
    try {
      this.#writer.event(event);
    } catch (error) {
      this.#reportFailure(error);
    }
  }

  /** Finish the capture. OAR's recorder makes this an explicit final line. */
  close(reason = "lane closed"): void {
    if (this.#closed) {
      return;
    }
    // A close can race a rejected/aborted submission. Preserve the canonical
    // line order even if the caller never receives the operation's receipt.
    for (const pending of this.#pendingSubmissions) {
      if (!pending.complete) {
        pending.complete = true;
        pending.via = pending.viaHint;
      }
    }
    this.#drain();
    try {
      if (!this.#failed) {
        this.#writer.end(reason);
      }
    } catch (error) {
      this.#reportFailure(error);
    } finally {
      this.#closed = true;
    }
  }
}

export async function createVoyageRecorder(
  options: VoyageRecorderOptions,
): Promise<CoxswainVoyageRecorder> {
  return CoxswainVoyageRecorder.create(options);
}
