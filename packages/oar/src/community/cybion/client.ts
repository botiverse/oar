import { asRecord, parseJson } from "../../shared/json.js";
import { replyMessage, type CybionReply } from "./refusal.js";

/** How a Cybion runtime reaches its deployment. */
export interface CybionOptions {
  /** Base URL of the Cybion deployment, e.g. `https://cybion.ntnl.io`. */
  readonly baseUrl: string;
  /** An Agent API key (`cyb_<user id>_<secret>`), minted in Cybion's own API-key settings. */
  readonly apiKey: string;
}

/** The `error` text of a Cybion body, when the body carries one. */
export function errorText(body: unknown): string | null {
  const value = asRecord(body)?.error;
  return typeof value === "string" && value !== "" ? value : null;
}

/**
 * The Cybion Agent API client (`/v1/threads`, docs/runtimes/cybion.md): a
 * bearer API key and JSON. Cybion answers every control with a plain JSON
 * body, so nothing here streams.
 */
export class CybionClient {
  readonly baseUrl: string;
  readonly #apiKey: string;

  constructor(options: CybionOptions) {
    this.baseUrl = options.baseUrl.replace(/\/+$/u, "");
    this.#apiKey = options.apiKey;
  }

  async call(method: string, path: string, body?: unknown): Promise<CybionReply> {
    const response = await fetch(`${this.baseUrl}${path}`, {
      method,
      headers: {
        authorization: `Bearer ${this.#apiKey}`,
        accept: "application/json",
        ...(body === undefined ? {} : { "content-type": "application/json" }),
      },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    });
    const text = await response.text();
    return { status: response.status, body: text === "" ? null : parseJson(text) };
  }

  /** The answer body, or an Error naming what Cybion answered. */
  async expect(method: string, path: string, body?: unknown): Promise<unknown> {
    const reply = await this.call(method, path, body);
    if (reply.status < 200 || reply.status >= 300) {
      throw new Error(`cybion ${method} ${path} answered ${String(reply.status)}: ${replyMessage(reply)}`);
    }
    return reply.body;
  }
}
