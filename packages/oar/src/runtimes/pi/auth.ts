import type {
  LoginProvider,
  LoginProviderMethod,
  ProviderAuthFacade,
  ProviderAuthStatus,
  ProviderLoginEvent,
  ProviderLoginInteraction,
  ProviderLoginMethod,
  ProviderLoginPrompt,
} from "../../contracts/provider-auth.js";
import { getAgentDir, ModelRuntime, SettingsManager } from "@earendil-works/pi-coding-agent";
import { configurePiHttp } from "./http.js";

/*
 * Pi's `ModelRuntime.login` takes its own `AuthInteraction` / `AuthType`, whose
 * types live in the transitive `@earendil-works/pi-ai` package (not a declared
 * oar dependency, and not in its public export). We recover both from the
 * method signature so nothing internal has to be imported by name.
 */
type PiLoginParameters = Parameters<ModelRuntime["login"]>;
type PiAuthType = PiLoginParameters[1];
type PiInteraction = PiLoginParameters[2];
type PiAuthEvent = Parameters<PiInteraction["notify"]>[0];
type PiAuthPrompt = Parameters<PiInteraction["prompt"]>[0];

export function toLoginEvent(event: PiAuthEvent): ProviderLoginEvent {
  switch (event.type) {
    case "auth_url":
      return {
        kind: "auth_url",
        url: event.url,
        ...(event.instructions === undefined ? {} : { instructions: event.instructions }),
      };
    case "device_code":
      return {
        kind: "device_code",
        userCode: event.userCode,
        verificationUri: event.verificationUri,
        ...(event.intervalSeconds === undefined ? {} : { intervalSeconds: event.intervalSeconds }),
        ...(event.expiresInSeconds === undefined ? {} : { expiresInSeconds: event.expiresInSeconds }),
      };
    case "info":
    case "progress":
      return { kind: "info", message: event.message };
  }
  // Unreachable: the switch is exhaustive over Pi's auth-event union.
  throw new Error("unhandled Pi auth event");
}

export function toLoginPrompt(prompt: PiAuthPrompt): ProviderLoginPrompt {
  if (prompt.type === "select") {
    return {
      kind: "select",
      message: prompt.message,
      options: prompt.options.map((option) => ({
        id: option.id,
        label: option.label,
        ...(option.description === undefined ? {} : { description: option.description }),
      })),
    };
  }
  return {
    kind: prompt.type,
    message: prompt.message,
    ...(prompt.placeholder === undefined ? {} : { placeholder: prompt.placeholder }),
  };
}

/** The part of a pi `Provider` its `/login` menu reads; every `Provider` is one. */
export interface PiLoginProvider {
  readonly id: string;
  readonly name: string;
  readonly auth: {
    readonly oauth?: { readonly name: string; readonly isSubscription?: boolean; readonly loginLabel?: string };
    readonly apiKey?: { readonly name: string; readonly login?: unknown };
  };
}

/**
 * One provider as pi's `/login` offers it (`getLoginProviderOptions`): its
 * OAuth sign-in, then its API key, ambient when pi has no prompt for it (pi:
 * "configured outside pi"). Undefined when it accepts neither.
 */
export function piLoginProvider(provider: PiLoginProvider): LoginProvider | undefined {
  const { oauth, apiKey } = provider.auth;
  const methods: LoginProviderMethod[] = [];
  if (oauth !== undefined) {
    methods.push({
      method: "oauth",
      name: oauth.name,
      subscription: oauth.isSubscription === true,
      ...(oauth.loginLabel === undefined ? {} : { loginLabel: oauth.loginLabel }),
    });
  }
  if (apiKey !== undefined) {
    methods.push(apiKey.login === undefined
      ? { method: "api_key", name: apiKey.name, ambient: true }
      : { method: "api_key", name: apiKey.name });
  }
  return methods.length === 0 ? undefined : { providerId: provider.id, name: provider.name, methods };
}

/** Bridge an oar {@link ProviderLoginInteraction} into Pi's interaction shape. */
function toPiInteraction(interaction: ProviderLoginInteraction): PiInteraction {
  return {
    ...(interaction.signal === undefined ? {} : { signal: interaction.signal }),
    notify: (event: PiAuthEvent): void => {
      interaction.onEvent(toLoginEvent(event));
    },
    prompt: async (prompt: PiAuthPrompt): Promise<string> => {
      const answer = await interaction.prompt(toLoginPrompt(prompt));
      return answer;
    },
  };
}

/**
 * A non-interactive interaction for `setApiKey`: it answers pi's key prompt
 * (the first prompt, a secret) with the key and refuses any other, which stops
 * the flow before pi stores anything. A flow that asks more (amazon-bedrock and
 * google-vertex ask which credential first, the Cloudflare providers ask for
 * account and gateway ids after the key) needs the person: `login`.
 */
function keyOnlyInteraction(providerId: string, apiKey: string): ProviderLoginInteraction {
  let keyGiven = false;
  return {
    onEvent: (): void => {
      // A key-only flow surfaces no URL or device code.
    },
    prompt: async (prompt: ProviderLoginPrompt): Promise<string> => {
      await Promise.resolve();
      if (!keyGiven && prompt.kind === "secret") {
        keyGiven = true;
        return apiKey;
      }
      throw new Error(`${providerId}'s API-key login asks more than the key (${prompt.kind}: "${prompt.message}"): `
        + `use login("${providerId}", "api_key", interaction) instead of setApiKey`);
    },
  };
}

class PiProviderAuth implements ProviderAuthFacade {
  readonly #runtime: ModelRuntime;

  constructor(runtime: ModelRuntime) {
    this.#runtime = runtime;
  }

  async #statusOf(providerId: string): Promise<ProviderAuthStatus> {
    const check = await this.#runtime.checkAuth(providerId);
    if (check === undefined) {
      return { providerId, configured: false };
    }
    const status = this.#runtime.getProviderAuthStatus(providerId);
    const label = status.label ?? check.source;
    return {
      providerId,
      configured: true,
      method: check.type === "oauth" ? "oauth" : "api_key",
      ...(label === undefined ? {} : { label }),
      // Pi's `isUsingSubscription`, read from this check: pi's own reads the
      // availability snapshot, which `refreshOnCreate: false` leaves empty.
      subscription: check.type === "oauth" && this.#runtime.getProvider(providerId)?.auth.oauth?.isSubscription === true,
    };
  }

  async listProviders(): Promise<readonly ProviderAuthStatus[]> {
    const credentials = await this.#runtime.listCredentials();
    return Promise.all(credentials.map(async (credential) => {
      const status = await this.#statusOf(credential.providerId);
      return status;
    }));
  }

  loginProviders(): readonly LoginProvider[] {
    // Pi's `/login` lists its providers by name.
    const providers = this.#runtime.getProviders().toSorted((left, right) => left.name.localeCompare(right.name));
    return providers.flatMap((provider) => piLoginProvider(provider) ?? []);
  }

  async status(providerId: string): Promise<ProviderAuthStatus> {
    const status = await this.#statusOf(providerId);
    return status;
  }

  async login(
    providerId: string,
    method: ProviderLoginMethod,
    interaction: ProviderLoginInteraction,
  ): Promise<ProviderAuthStatus> {
    const authType: PiAuthType = method;
    await this.#runtime.login(providerId, authType, toPiInteraction(interaction));
    const status = await this.#statusOf(providerId);
    return status;
  }

  async setApiKey(providerId: string, apiKey: string): Promise<void> {
    // Persist the key by running pi's api-key login flow, answering its key
    // prompt and nothing else (see keyOnlyInteraction).
    const authType: PiAuthType = "api_key";
    await this.#runtime.login(providerId, authType, toPiInteraction(keyOnlyInteraction(providerId, apiKey)));
  }

  async logout(providerId: string): Promise<void> {
    await this.#runtime.logout(providerId);
  }
}

export interface PiProviderAuthOptions {
  /** Path to Pi's `auth.json`; defaults to Pi's `~/.pi/agent/auth.json`. */
  readonly authPath?: string;
  /** Path to Pi's `models.json` (custom providers, listed by `loginProviders()` too); `null` disables the static config. */
  readonly modelsPath?: string | null;
}

/** Create a {@link ProviderAuthFacade} backed by Pi's `ModelRuntime`. */
export async function createPiProviderAuth(options: PiProviderAuthOptions = {}): Promise<ProviderAuthFacade> {
  // OAuth login/refresh goes over the network: the proxy plane first, from
  // the same settings (OAR_PI_AGENT_DIR ?? pi's agent dir) every pi entry
  // point of the adapter reads, so login behaves like a session (see http.ts).
  await configurePiHttp(SettingsManager.create(process.cwd(), process.env.OAR_PI_AGENT_DIR ?? getAgentDir()));
  const runtime = await ModelRuntime.create({
    ...(options.authPath === undefined ? {} : { authPath: options.authPath }),
    ...(options.modelsPath === undefined ? {} : { modelsPath: options.modelsPath }),
    allowModelNetwork: false,
    refreshOnCreate: false,
  });
  return new PiProviderAuth(runtime);
}
