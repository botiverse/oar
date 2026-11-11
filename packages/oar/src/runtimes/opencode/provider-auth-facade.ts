import type {
  LoginProvider,
  ProviderAuthStatus,
  ProviderLoginInteraction,
  ProviderLoginMethod,
} from "../../contracts/provider-auth.js";
import { asRecord } from "../../shared/json.js";
import { LoginSecrets } from "../../shared/login.js";
import { OpencodeProviderAuthError } from "./provider-auth-error.js";
import { runOauth } from "./provider-auth-oauth.js";
import { ask, askForm, formAsks, type FormValue } from "./provider-auth-prompts.js";
import { loginProviderOf, parseIntegration, parseIntegrations, statusOf, type OpencodeIntegration } from "./provider-auth-registry.js";
import { nativeDetail, OpencodeServer, type ApiCall, type OpencodeServerOptions } from "./provider-auth-server.js";
import type { OpencodeProviderAuth } from "./provider-auth.js";

export interface OpencodeFacadeOptions extends OpencodeServerOptions {
  /** Bound for one login, the person's time included. */
  readonly loginTimeoutMs: number;
  /** How often a login reads its attempt's status. */
  readonly statusPollMs: number;
}

const integrationPath = (id: string): string => `/api/integration/${encodeURIComponent(id)}`;

async function readIntegration(call: ApiCall, id: string): Promise<OpencodeIntegration> {
  const response = await call("GET", integrationPath(id));
  const integration = response.status === 200 ? parseIntegration(asRecord(response.body)?.data) : undefined;
  if (response.status === 404) {
    throw new OpencodeProviderAuthError("unknown_provider", `OpenCode has no integration ${JSON.stringify(id)}`, 404);
  }
  if (integration === undefined) {
    throw new OpencodeProviderAuthError("rejected", `OpenCode did not describe ${id} (${nativeDetail(response, new LoginSecrets())})`, response.status);
  }
  return integration;
}

/** Remove credentials through OpenCode's own `credential.remove` (DELETE answers 204, also for one already gone). */
async function removeCredentials(call: ApiCall, providerId: string, ids: readonly string[]): Promise<void> {
  for (const id of ids) {
    const response = await call("DELETE", `/api/credential/${encodeURIComponent(id)}`);
    if (response.status >= 300) {
      throw new OpencodeProviderAuthError("rejected", `OpenCode did not remove a ${providerId} credential (${nativeDetail(response, new LoginSecrets())})`, response.status);
    }
  }
}

async function listIntegrations(call: ApiCall): Promise<OpencodeIntegration[]> {
  const response = await call("GET", "/api/integration");
  return parseIntegrations(response.body);
}

const credentialIds = (integration: OpencodeIntegration): string[] =>
  integration.connections.flatMap((entry) => (entry.type === "credential" ? [entry.id] : []));

export class OpencodeProviderAuthFacade implements OpencodeProviderAuth {
  readonly #server: OpencodeServer;
  readonly #registry: readonly OpencodeIntegration[];
  readonly #options: OpencodeFacadeOptions;

  private constructor(server: OpencodeServer, registry: readonly OpencodeIntegration[], options: OpencodeFacadeOptions) {
    this.#server = server;
    this.#registry = registry;
    this.#options = options;
  }

  /** Start OpenCode's server once to read its registry, which `loginProviders()` then serves. */
  static async create(options: OpencodeFacadeOptions): Promise<OpencodeProviderAuthFacade> {
    const server = new OpencodeServer(options);
    try {
      const registry = await server.run(listIntegrations);
      return new OpencodeProviderAuthFacade(server, registry, options);
    } catch (error) {
      await server.close();
      throw error;
    }
  }

  async listProviders(): Promise<readonly ProviderAuthStatus[]> {
    const integrations = await this.#server.run(listIntegrations);
    // The contract lists stored credentials only; environment-only keys are not listed.
    return integrations
      .filter((integration) => integration.connections.some((entry) => entry.type === "credential"))
      .map((integration) => statusOf(integration.id, integration.connections));
  }

  loginProviders(): readonly LoginProvider[] {
    return this.#registry.flatMap((integration) => loginProviderOf(integration) ?? []);
  }

  async status(providerId: string): Promise<ProviderAuthStatus> {
    const integration = await this.#server.run(async (call) => {
      const read = await readIntegration(call, providerId);
      return read;
    });
    return statusOf(providerId, integration.connections);
  }

  async login(providerId: string, method: ProviderLoginMethod, interaction: ProviderLoginInteraction): Promise<ProviderAuthStatus> {
    interaction.signal?.throwIfAborted();
    const secrets = new LoginSecrets();
    const status = await this.#server.run(async (call) => {
      const integration = await readIntegration(call, providerId);
      if (method === "oauth") {
        await runOauth({ call, integration, interaction, secrets, timeoutMs: this.#options.loginTimeoutMs, pollMs: this.#options.statusPollMs });
      } else {
        const key = this.#keyMethod(integration);
        const signal = interaction.signal === undefined ? {} : { signal: interaction.signal };
        const apiKey = await ask(interaction, { ...signal, kind: "secret", message: key.label ?? `${integration.name} API key` });
        secrets.add(apiKey);
        const answer = await askForm(interaction, key.form, interaction.signal);
        interaction.signal?.throwIfAborted();
        await this.#storeKey(call, integration, apiKey, answer, secrets);
      }
      const after = await readIntegration(call, providerId);
      return statusOf(providerId, after.connections);
    });
    return status;
  }

  async setApiKey(providerId: string, apiKey: string): Promise<void> {
    const secrets = new LoginSecrets();
    secrets.add(apiKey);
    await this.#server.run(async (call) => {
      const integration = await readIntegration(call, providerId);
      if (formAsks(this.#keyMethod(integration).form)) {
        throw new OpencodeProviderAuthError("method_unavailable",
          `${providerId}'s API-key sign-in asks more than the key: use login("${providerId}", "api_key", interaction) instead of setApiKey`);
      }
      await this.#storeKey(call, integration, apiKey, {}, secrets);
    });
  }

  /** Every stored credential of the integration, through OpenCode's own removal; environment variables stay. */
  async logout(providerId: string): Promise<void> {
    await this.#server.run(async (call) => {
      const integration = await readIntegration(call, providerId);
      await removeCredentials(call, providerId, credentialIds(integration));
    });
  }

  async close(): Promise<void> {
    await this.#server.close();
  }

  #keyMethod(integration: OpencodeIntegration): Extract<OpencodeIntegration["methods"][number], { type: "key" }> {
    const key = integration.methods.find((entry) => entry.type === "key");
    if (key?.type !== "key") {
      const env = integration.methods.find((entry) => entry.type === "env");
      const ambient = env?.type === "env" ? `; OpenCode reads ${env.names.join(", ")} from its environment` : "";
      throw new OpencodeProviderAuthError("method_unavailable", `OpenCode has no API-key prompt for ${integration.id}${ambient}`);
    }
    return key;
  }

  /**
   * `integration.connect.key` adds a credential and makes it active without
   * validating it; the integration's earlier credentials are then removed, so
   * the new key replaces them. A refused key removes nothing.
   */
  async #storeKey(call: ApiCall, integration: OpencodeIntegration, apiKey: string, answer: Readonly<Record<string, FormValue>>, secrets: LoginSecrets): Promise<void> {
    const earlier = credentialIds(integration);
    const response = await call("POST", `${integrationPath(integration.id)}/connect/key`, {
      key: apiKey,
      ...(Object.keys(answer).length === 0 ? {} : { answer }),
    });
    if (response.status >= 300) {
      throw new OpencodeProviderAuthError("rejected", `OpenCode did not store the ${integration.id} key (${nativeDetail(response, secrets)})`, response.status);
    }
    await removeCredentials(call, integration.id, earlier);
  }
}
