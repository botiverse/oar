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
  /** Whether an OAuth attempt only a browser on the server's machine can finish is offered or refused. */
  readonly loopback: "allow" | "refuse";
}

const integrationPath = (id: string): string => `/api/integration/${encodeURIComponent(id)}`;

/** `integration.get`; undefined when OpenCode has no such integration (404). */
async function findIntegration(call: ApiCall, id: string): Promise<OpencodeIntegration | undefined> {
  const response = await call("GET", integrationPath(id));
  if (response.status === 404) {
    return undefined;
  }
  const integration = response.status === 200 ? parseIntegration(asRecord(response.body)?.data) : undefined;
  if (integration === undefined) {
    throw new OpencodeProviderAuthError("rejected", `OpenCode did not describe ${id} (${nativeDetail(response, new LoginSecrets())})`, response.status);
  }
  return integration;
}

async function readIntegration(call: ApiCall, id: string): Promise<OpencodeIntegration> {
  const integration = await findIntegration(call, id);
  if (integration === undefined) {
    throw new OpencodeProviderAuthError("unknown_provider", `OpenCode has no integration ${JSON.stringify(id)}`, 404);
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

/**
 * After a sign-in stored a credential, remove the integration's `earlier`
 * ones, so the new one replaces them instead of piling up labels (`xAI 2`,
 * `xAI 3`). Only when OpenCode now lists a credential it did not list
 * before: one updated in place removes nothing. The new credential is active
 * either way (OpenCode lists the newest first), so a failed removal is not
 * reported and an earlier credential may remain. Returns the status after
 * the sign-in.
 */
async function replaceEarlier(call: ApiCall, providerId: string, earlier: readonly string[]): Promise<ProviderAuthStatus> {
  const after = await readIntegration(call, providerId);
  const current = credentialIds(after);
  const stale = earlier.filter((id) => current.includes(id));
  if (stale.length > 0 && current.some((id) => !earlier.includes(id))) {
    try {
      await removeCredentials(call, providerId, stale);
    } catch {
      // Best effort, as above.
    }
  }
  return statusOf(providerId, after.connections);
}

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

  /** An integration OpenCode does not know is not configured, as with Pi. */
  async status(providerId: string): Promise<ProviderAuthStatus> {
    const integration = await this.#server.run(async (call) => {
      const found = await findIntegration(call, providerId);
      return found;
    });
    return statusOf(providerId, integration?.connections ?? []);
  }

  async login(providerId: string, method: ProviderLoginMethod, interaction: ProviderLoginInteraction): Promise<ProviderAuthStatus> {
    interaction.signal?.throwIfAborted();
    const secrets = new LoginSecrets();
    const { loginTimeoutMs, statusPollMs, loopback } = this.#options;
    const status = await this.#server.run(async (call) => {
      const integration = await readIntegration(call, providerId);
      if (method === "oauth") {
        await runOauth({ call, integration, interaction, secrets, timeoutMs: loginTimeoutMs, pollMs: statusPollMs, loopback });
      } else {
        const key = this.#keyMethod(integration);
        const signal = interaction.signal === undefined ? {} : { signal: interaction.signal };
        const apiKey = await ask(interaction, { ...signal, kind: "secret", message: key.label ?? `${integration.name} API key` });
        secrets.add(apiKey);
        const answer = await askForm(interaction, key.form, interaction.signal);
        interaction.signal?.throwIfAborted();
        await this.#storeKey(call, integration, apiKey, answer, secrets);
      }
      const after = await replaceEarlier(call, providerId, credentialIds(integration));
      return after;
    });
    return status;
  }

  /** Stores the key, then removes earlier credentials best effort: once the key is stored it resolves, and an earlier credential may remain. */
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
      try {
        await replaceEarlier(call, providerId, credentialIds(integration));
      } catch {
        // The new key is stored and active.
      }
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
   * validating it. A refused key stores nothing and removes nothing.
   */
  async #storeKey(call: ApiCall, integration: OpencodeIntegration, apiKey: string, answer: Readonly<Record<string, FormValue>>, secrets: LoginSecrets): Promise<void> {
    const response = await call("POST", `${integrationPath(integration.id)}/connect/key`, {
      key: apiKey,
      ...(Object.keys(answer).length === 0 ? {} : { answer }),
    });
    if (response.status >= 300) {
      throw new OpencodeProviderAuthError("rejected", `OpenCode did not store the ${integration.id} key (${nativeDetail(response, secrets)})`, response.status);
    }
  }
}
