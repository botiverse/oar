/**
 * Operational capabilities: what a consumer may DO while driving a session.
 *
 * NOT config options. Config options are what you fill in BEFORE start (model,
 * reasoning effort, credentials) and are what a create-agent form is generated
 * from. The membership test:
 *
 *   branch on it while driving a session  -> capability (here)
 *   decide it before starting             -> config option (elsewhere)
 *
 * They are kept apart because they interact: a launch-time option may change
 * what is operationally possible. Fuse the two and the question "is this fixed
 * at launch or does it vary within a session?" stops being expressible.
 *
 * Admissibility: an axis exists here only where a consumer must branch on it.
 * If two values are indistinguishable to a consumer, they are not two contract
 * values -- absorbing that difference is this layer's job, not the caller's.
 *
 * Deliberately flat: booleans and limits, one per thing a consumer may rely on.
 * A richer ontology is not earned yet.
 */
export interface Capabilities {
  /** Input can be delivered while a turn is in flight. */
  readonly steer: boolean;
  /** An in-flight turn can be stopped without ending the session. */
  readonly interrupt: boolean;
  /** A prior session can be resumed and remains drivable afterwards. */
  readonly resume: boolean;
  /**
   * The host can answer a tool-call permission decision, and its answer
   * changes what happens next. Observation-only runtimes report false: being
   * able to SEE a tool call is not being able to refuse it.
   */
  readonly interceptToolCalls: boolean;
}

/**
 * Capability is RESOLVED, not declared.
 *
 * Support depends on the runtime AND on what it was configured with -- in the
 * extraction source, reasoning effort is gated first by runtime and then again
 * by the selected model, so `max`/`ultra` exist only for models that declare
 * them. A constant per driver cannot express "steer, from version X onward".
 *
 * This is why discovery (is it installed, which version) has to precede
 * negotiation (what can it do): merged, the first real failure -- present but
 * too old -- has no owner.
 */
export interface CapabilitySource {
  readonly runtime: string;
  readonly version: string;
  /** Absent when the runtime has no model dimension. */
  readonly model?: string;
}
