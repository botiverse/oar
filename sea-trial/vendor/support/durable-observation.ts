import { vi } from "vitest";
import type { ConversationView, Harness, Observer } from "@earendil-works/pi-durable";

/** Delay delivery at the adapter boundary, retaining every real native callback. */
export function holdDurableObservation(harness: Harness): () => void {
  const native = harness.observeConversation.bind(harness);
  const pending: (() => void)[] = [];
  let held = true;
  const send = (callback: () => void): void => { if (held) { pending.push(callback); } else { callback(); } };
  vi.spyOn(harness, "observeConversation").mockImplementation(async (id, observer, context, window) => {
    const result = await native(id, {
      advance(call, sourceContext) { send(() => { observer.advance(call, sourceContext); }); },
      end(end) { send(() => { observer.end(end); }); },
    }, context, window);
    return result;
  });
  return (): void => { held = false; for (const callback of pending.splice(0)) { callback(); } };
}

export function captureDurableObserver(harness: Harness): { current?: Observer<ConversationView> } {
  const captured: { current?: Observer<ConversationView> } = {};
  const native = harness.observeConversation.bind(harness);
  vi.spyOn(harness, "observeConversation").mockImplementation(async (id, observer, context, window) => {
    captured.current = observer;
    const result = await native(id, observer, context, window);
    return result;
  });
  return captured;
}
