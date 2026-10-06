/* oxlint-disable eslint/max-classes-per-file -- the fake SDK and its file store are one stand-in. */
import assert from "node:assert/strict";
import { vi } from "vitest";
import { createCursorRuntime, type CursorRuntime, type CursorSdk } from "../../packages/oar/src/index.js";
import type { LoginOptions, LoginResult } from "../../packages/oar/src/contracts/login.js";
import type { CursorAuth, CursorAuthStatus, CursorLoginOptions } from "../../packages/oar/src/runtimes/cursor/sdk.js";
import { recordedInteraction, type RecordedInteraction } from "./login-interaction.js";

export const bundled = { kind: "available", via: "bundled" } as const;
export const LOGIN_URL = "https://cursor.com/loginDeepControl?challenge=Q2hhbGxlbmdl&uuid=0b5c7a52-2a39-4c55-9a3e-1f0e8e1f3a11&mode=login&redirectTarget=sdk";
/** The minted key: never in an event, a result or a detail. */
export const KEY = "crsr_fake_minted_key_0123456789abcdef";
export const EXPIRES_MS = Date.UTC(2027, 0, 4, 12);
/** A login stored before the test's own. */
export const PREVIOUS: CursorAuthStatus = { status: "logged-in", email: "previous@example.com", apiKeyExpiresAtMs: Date.UTC(2026, 11, 1) };
/** What the fake's login refuses to save after OAR ended it. */
export const REFUSED = "the login ended before cursor stored its key; nothing was written";

export const unused = (): never => assert.fail("a login uses only Cursor.auth and FileCredentialStore");

/** Whether the minted key shows anywhere in `value`. */
export function leaks(value: unknown): boolean {
  return JSON.stringify(value).includes(KEY);
}

export interface FakeCursorOptions {
  /** What `status()` reads before any save (the stored login), or how it fails. */
  readonly stored?: CursorAuthStatus | Error | "never";
  /** What `status()` reads after a save. */
  readonly afterSave?: CursorAuthStatus | Error;
  /** The SDK's own file store fails to write. */
  readonly saveError?: Error;
}

/**
 * A stand-in for `@cursor/sdk` 1.0.35's `Cursor.auth`, in the order its
 * bundle runs a login: `onLoginUrl`, then the poll (it ends when the person
 * signs in, or on the signal with `Login was cancelled.`), then the key
 * minting, which takes no signal, then `store.save` and resolve. Its
 * `FileCredentialStore` writes what `status()` reads, as
 * `~/.cursor/sdk/auth.json` does.
 */
export class FakeCursor {
  /** What reached the SDK's own file store. */
  readonly writes: object[] = [];
  readonly logins: CursorLoginOptions[] = [];
  /** Settles with how the SDK's own login ended: `resolved` or its error's message. */
  readonly sdkOutcome = Promise.withResolvers<string>();
  readonly sdk: CursorSdk;
  /** The file store's save has begun. */
  saving = false;
  loads = 0;
  private stored: CursorAuthStatus | Error | "never";
  private readonly browser = Promise.withResolvers<void>();
  private readonly minted = Promise.withResolvers<void>();
  /** A save goes through unless the test holds it. */
  private saveHeld: Promise<void> = Promise.resolve();

  constructor(private readonly options: FakeCursorOptions = {}) {
    this.stored = options.stored ?? { status: "logged-out" };
    const save = async (credentials: object): Promise<void> => {
      await this.save(credentials);
    };
    this.sdk = {
      Agent: { create: unused, resume: unused, listRuns: unused },
      Cursor: { models: { list: unused }, auth: this.auth },
      FileCredentialStore: class {
        async save(credentials: object): Promise<void> {
          await save(credentials);
        }
      },
    };
  }

  readonly auth: CursorAuth = {
    login: async (options) => {
      this.logins.push(options);
      options.onLoginUrl(LOGIN_URL);
      try {
        await this.poll(options.signal);
        // The SDK's minting takes no signal.
        await this.minted.promise;
        await options.store.save({ version: 1, backendUrl: "https://api2.cursor.sh", apiKey: KEY, apiKeyExpiresAtMs: EXPIRES_MS, email: "user@example.com", createdAtMs: 1 });
        this.sdkOutcome.resolve("resolved");
        return { apiKey: KEY, email: "user@example.com", apiKeyExpiresAtMs: EXPIRES_MS };
      } catch (error) {
        this.sdkOutcome.resolve(error instanceof Error ? error.message : String(error));
        throw error;
      }
    },
    status: async () => {
      const { stored } = this;
      if (stored === "never") {
        const unanswered = await Promise.withResolvers<never>().promise;
        return unanswered;
      }
      if (stored instanceof Error) {
        throw stored;
      }
      return stored;
    },
  };

  /** The person finished the sign-in in the browser; the SDK's poll then fails with `error`, if given. */
  signIn(error?: Error): this {
    if (error === undefined) {
      this.browser.resolve();
    } else {
      this.browser.reject(error);
    }
    return this;
  }

  /** The key minting ends, failing with `error` if given. */
  mint(error?: Error): this {
    if (error === undefined) {
      this.minted.resolve();
    } else {
      this.minted.reject(error);
    }
    return this;
  }

  /** The next save waits until the returned release is called. */
  holdSave(): () => void {
    const held = Promise.withResolvers<void>();
    this.saveHeld = held.promise;
    return () => {
      held.resolve();
    };
  }

  runtime(): CursorRuntime {
    return createCursorRuntime({
      sdk: async () => {
        this.loads += 1;
        return this.sdk;
      },
    });
  }

  /** `FileCredentialStore.save`: what `status()` reads from then on. */
  private async save(credentials: object): Promise<void> {
    this.saving = true;
    await this.saveHeld;
    if (this.options.saveError !== undefined) {
      throw this.options.saveError;
    }
    this.writes.push(credentials);
    this.stored = this.options.afterSave ?? { status: "logged-in", email: "user@example.com", apiKeyExpiresAtMs: EXPIRES_MS };
  }

  private async poll(signal: AbortSignal): Promise<void> {
    const aborted = Promise.withResolvers<never>();
    const onAbort = (): void => {
      aborted.reject(new Error("Login was cancelled."));
    };
    signal.addEventListener("abort", onAbort, { once: true });
    try {
      await Promise.race([this.browser.promise, aborted.promise]);
    } finally {
      signal.removeEventListener("abort", onAbort);
    }
  }
}

export interface StartedLogin {
  readonly login: Promise<LoginResult>;
  readonly interaction: RecordedInteraction;
  readonly abort: AbortController;
}

/** A login on `fake`'s runtime, once its URL has reached the host. */
export async function startLogin(fake: FakeCursor, options: LoginOptions = {}): Promise<StartedLogin> {
  const abort = new AbortController();
  const interaction = recordedInteraction([], { signal: abort.signal });
  const login = fake.runtime().login(bundled, interaction, options);
  await vi.waitFor(() => {
    assert.equal(interaction.events.length, 1);
  });
  return { login, interaction, abort };
}
