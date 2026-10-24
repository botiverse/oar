/** A slot stays occupied until the native operation settles, even after its observer times out. */
export class ProbeSlots {
  #active = 0;
  readonly #waiting: (() => void)[] = [];
  async run<T>(operation: () => Promise<T>): Promise<T> {
    if (this.#active >= 2) { await new Promise<void>((resolve) => { this.#waiting.push(resolve); }); }
    else { this.#active += 1; }
    try { return await operation(); }
    finally {
      const next = this.#waiting.shift();
      if (next === undefined) { this.#active -= 1; } else { next(); }
    }
  }
}
