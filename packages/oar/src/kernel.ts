/**
 * The runtime-author SPI: the record stream every built-in adapter is built
 * on (`createSessionKernel`) and the API face derived over it
 * (`sealSession`). Pair with `defineRuntime` to ship a custom runtime (a
 * scripted runtime for a host's tests, an in-process agent) without
 * re-implementing the stream contract: dense seq, cursor replay, the
 * reachability rule, and control recording all come with the kernel.
 * `inputImagesRefusal` and `withInputImages` hold the image rules every
 * built-in runtime keeps (no image input, not png/jpeg/gif/webp, or
 * unreadable refuses the whole input), so a custom runtime keeps them too.
 * `withdrawHeld` is the decision behind `withdraw` for a runtime that holds
 * its own queue: remove the held entry for an `inputId`, or `not_queued`.
 */
export { createSessionKernel } from "./shared/session-kernel.js";
export type { RecordAt, SessionKernel } from "./shared/session-kernel.js";
export { controlOutcomeOf, sealSession } from "./shared/seal-session.js";
export { inputImagesRefusal, withInputImages } from "./shared/input-images.js";
export type { LoadedImage } from "./shared/input-images.js";
export { withdrawHeld } from "./shared/held-input.js";
export type { HeldInput } from "./shared/held-input.js";
