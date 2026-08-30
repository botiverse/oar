import type {
  ProviderAuthFacade,
  ProviderAuthStatus,
  ProviderLoginEvent,
  ProviderLoginInteraction,
  ProviderLoginMethod,
  ProviderLoginPrompt,
} from "../../contracts/provider-auth.js";
import { ModelRuntime } from "@earendil-works/pi-coding-agent";

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

/** A non-interactive interaction that answers every prompt with a fixed value. */
function fixedAnswerInteraction(answer: string): ProviderLoginInteraction {
  return {
    onEvent: (): void => {
      // A non-interactive api-key flow surfaces no URL or device code.
    },
    prompt: async (): Promise<string> => {
      await Promise.resolve();
      return answer;
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
      subscription: this.#runtime.isUsingSubscription(providerId),
    };
  }

  async listProviders(): Promise<readonly ProviderAuthStatus[]> {
    const credentials = await this.#runtime.listCredentials();
    return Promise.all(credentials.map(async (credential) => {
      const status = await this.#statusOf(credential.providerId);
      return status;
    }));
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
    // Persist the key by running the api-key login flow with a non-interactive
    // interaction that answers the secret prompt with the supplied key.
    const authType: PiAuthType = "api_key";
    await this.#runtime.login(providerId, authType, toPiInteraction(fixedAnswerInteraction(apiKey)));
  }

  async logout(providerId: string): Promise<void> {
    await this.#runtime.logout(providerId);
  }
}

export interface PiProviderAuthOptions {
  /** Path to Pi's `auth.json`; defaults to Pi's `~/.pi/agent/auth.json`. */
  readonly authPath?: string;
}

/** Create a {@link ProviderAuthFacade} backed by Pi's `ModelRuntime`. */
export async function createPiProviderAuth(options: PiProviderAuthOptions = {}): Promise<ProviderAuthFacade> {
  const runtime = await ModelRuntime.create({
    ...(options.authPath === undefined ? {} : { authPath: options.authPath }),
    allowModelNetwork: false,
    refreshOnCreate: false,
  });
  return new PiProviderAuth(runtime);
}
