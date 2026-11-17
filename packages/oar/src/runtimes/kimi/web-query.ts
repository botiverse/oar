import { requestFailure } from "../../shared/credential-http.js";
import type { LineProcess } from "../../shared/executable/index.js";
import { asRecord, type JsonRecord } from "../../shared/json.js";

export interface WebEndpoint { readonly origin: string; readonly token: string }

/** The banner is private: never forward native stdout/stderr or its bearer token. */
export async function kimiWebEndpoint(child: LineProcess, signal: AbortSignal): Promise<WebEndpoint> {
  const { promise, resolve, reject } = Promise.withResolvers<WebEndpoint>();
  {
    signal.addEventListener("abort", () => { reject(new Error("Kimi discovery stopped")); }, { once: true });
    child.onExit(() => { reject(new Error("Kimi discovery exited")); });
    child.onLine((line) => {
      // oxlint-disable-next-line no-control-regex -- Stop at a native ANSI color escape without retaining the token.
      const match = /http:\/\/127\.0\.0\.1:([0-9]+)\/?#token=([^\s\u001B]+)/u.exec(line);
      if (match?.[1] !== undefined && match[2] !== undefined && Number(match[1]) > 0 && Number(match[1]) <= 65_535) {
        resolve({ origin: `http://127.0.0.1:${match[1]}`, token: match[2] });
      }
    });
  }
  const value = await promise;
  return value;
}

export async function kimiWebRequest(web: WebEndpoint, signal: AbortSignal, path: string, method = "GET", body?: JsonRecord): Promise<JsonRecord> {
  const response = await fetch(`${web.origin}/api/v1${path}`, {
    method, signal, redirect: "error",
    headers: { Authorization: `Bearer ${web.token}`, ...(body === undefined ? {} : { "Content-Type": "application/json" }) },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  }).catch((error: unknown) => { throw requestFailure("Kimi Web request failed", error); });
  if (!response.ok) { throw new Error("Kimi discovery HTTP failure"); }
  const payload: unknown = await response.json().catch(() => { throw new Error("Kimi Web response is not valid JSON"); });
  const envelope = asRecord(payload);
  const data = asRecord(envelope?.data);
  if (envelope?.code !== 0 || data === null) { throw new Error("Kimi discovery query failed"); }
  return data;
}

