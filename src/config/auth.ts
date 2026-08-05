/**
 * Chapter 6, the auth axis. How a runtime authenticates differs in KIND, not
 * degree, so it is a declared axis rather than a config field.
 *
 * Independently confirmed: production config divides exactly these four ways,
 * and the axis was derived from failure experience before that was checked.
 */
export type AuthMode =
  /** The runtime's own login state on the host. THIS LAYER HOLDS NOTHING. */
  | { readonly kind: "ambient" }
  /** The caller supplies a credential reference. */
  | { readonly kind: "explicit_key" }
  /** The host holds a session obtained on the user's behalf. */
  | { readonly kind: "delegated" }
  /** The host routes through its own endpoint; the runtime never sees a provider credential. */
  | { readonly kind: "gateway" };

/**
 * Holding no secret is FIRST-CLASS, not a degenerate case: `ambient` lets a
 * consumer drive a runtime without ever touching a credential. Layers that
 * build explicit-key first and retrofit ambient leave it second-class forever.
 */

/**
 * A REFERENCE to a credential. Never the credential.
 *
 * Credentials must not enter ordinary runtime config or a restart snapshot --
 * a reference travels and is materialised at launch. A reference and a
 * resolved credential are TWO TYPES, converted only by a function that can
 * fail, never by an assertion. The production crash that motivated this
 * project was one assertion collapsing exactly that distinction.
 */
export interface CredentialRef {
  readonly ref: string;
}

/**
 * What mode a session ACTUALLY authenticated with, readable back.
 *
 * The classic failure in credential chains is silent fallback: you believe you
 * are using key A and you are using whatever the environment held. For agents
 * that is worse than wrong -- it bills someone else. Configured-as is not
 * authenticated-as, so the resolved mode is reported as a closed-set name,
 * never the secret.
 */
export interface ResolvedAuth {
  readonly mode: AuthMode["kind"];
}
