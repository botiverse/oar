import type { UtcInstant } from "../../contracts/account-usage.js";
import type { Probe } from "../../contracts/orientation.js";
import type { ProbeSlots } from "./slots.js";
import { utcInstantFromDate } from "../instant.js";

export function observedNow(): UtcInstant {
  const instant = utcInstantFromDate(new Date());
  if (instant === null) { throw new RangeError("Clock did not return a valid date"); }
  return instant;
}

/** One runtime gets at most 45 seconds, one probe 30, and neither can outlive the whole call. */
export class ProbeBudget {
  readonly #until: number;
  readonly #signal: AbortSignal | undefined;
  constructor(until: number, signal: AbortSignal | undefined) {
    this.#until = Math.min(until, Date.now() + 45_000);
    this.#signal = signal;
  }
  remaining(): number { return Math.max(0, Math.min(30_000, this.#until - Date.now())); }
  async run<T>(operation: ((timeoutMs: number) => Promise<T>) | undefined, slots?: ProbeSlots): Promise<Probe<T>> {
    this.#signal?.throwIfAborted();
    if (operation === undefined) { return { kind: "unsupported" }; }
    const timeoutMs = this.remaining();
    if (timeoutMs <= 0) { return { kind: "timed_out", observedAt: observedNow() }; }
    const result = await this.#read(operation, timeoutMs, slots);
    return result;
  }
  async #read<T>(operation: (timeoutMs: number) => Promise<T>, timeoutMs: number, slots: ProbeSlots | undefined): Promise<Probe<T>> {
    const expired = Symbol("expired");
    const deadline = Promise.withResolvers<typeof expired>();
    const until = Date.now() + timeoutMs;
    const timer = setTimeout(() => { deadline.resolve(expired); }, timeoutMs);
    const abort = (): void => { deadline.reject(this.#signal?.reason); };
    this.#signal?.addEventListener("abort", abort, { once: true });
    const start = async (): Promise<T | typeof expired> => {
      this.#signal?.throwIfAborted();
      const left = Math.min(until - Date.now(), this.remaining());
      if (left <= 0) { return expired; }
      const result = await operation(left);
      return result;
    };
    try {
      const result = await Promise.race([slots === undefined ? start() : slots.run(start), deadline.promise]);
      return result === expired ? { kind: "timed_out", observedAt: observedNow() } : { kind: "ok", value: result, observedAt: observedNow() };
    } catch {
      this.#signal?.throwIfAborted();
      // Native errors can contain credentials; only adapter-produced public facts are returned.
      return { kind: "failed", reason: "The runtime query failed", observedAt: observedNow() };
    } finally {
      clearTimeout(timer);
      this.#signal?.removeEventListener("abort", abort);
    }
  }
}
