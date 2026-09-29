/**
 * The runtime-author SPI: the record stream every built-in adapter is built
 * on (`createSessionKernel`) and the API face derived over it
 * (`sealSession`). Pair with `defineRuntime` to ship a custom runtime (a
 * scripted runtime for a host's tests, an in-process agent) without
 * re-implementing the stream contract: dense seq, cursor replay, the
 * reachability rule, control recording, and the answer bookkeeping of
 * runtime→app requests (`SessionKernel.answer`) all come with the kernel.
 */
export { createSessionKernel } from "./shared/session-kernel.js";
export type { AnswerDelivery, DeliverAnswer, RecordAt, SessionKernel } from "./shared/session-kernel.js";
export { controlOutcomeOf, sealSession } from "./shared/seal-session.js";
