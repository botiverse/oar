/**
 * A local stand-in for the part of Cursor's backend that `Cursor.auth.login()`
 * (`@cursor/sdk` 1.0.35) talks to, read from the SDK's bundle:
 *
 * - the browser page `GET /loginDeepControl?challenge=…&uuid=…` (the SDK only
 *   builds its URL; here the probe "opens" it, which signs that uuid in);
 * - `POST /auth/poll {uuid, verifier}`: `404 Not found` while the sign-in is
 *   pending, then `{accessToken, refreshToken}` once the page was opened and
 *   `base64url(sha256(verifier))` matches the page's challenge (the SDK falls
 *   back to `GET /auth/poll?uuid=…&verifier=…` when the first 404's body is not
 *   exactly `Not found`; that fallback is counted, never expected);
 * - Connect unary RPCs over HTTP/1.1 with binary protobuf
 *   (`application/proto`): `aiserver.v1.DashboardService/CreateUserApiKey`
 *   (`1 name`, `3 expires_at` → `1 api_key`) and `GetMe` (→ `3 email`), both
 *   with `Authorization: Bearer <accessToken>`.
 *
 * Every key and token it hands out is an obviously fake constant.
 */
import { createHash } from "node:crypto";
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";

export const MOCK_KEY = "crsr_mock_minted_key_not_a_secret";
export const MOCK_EMAIL = "sdk-login-probe@example.invalid";
export const ACCESS_TOKEN = "mock-access-token-not-a-secret";
const REFRESH_TOKEN = "mock-refresh-token-not-a-secret";
const SERVICE = "/aiserver.v1.DashboardService/";

export interface MintRequest {
  /** The key's display name (`1 name`). */
  readonly name: string;
  /** `3 expires_at`, epoch ms. */
  readonly expiresAtMs: number | undefined;
  /** The request carried the access token the poll handed out. */
  readonly bearer: boolean;
}

export interface MockObservations {
  /** `POST /auth/poll` requests. */
  polls: number;
  /** `GET /auth/poll`: the fallback that puts the verifier in the URL. */
  getPolls: number;
  /** A poll's verifier hashed to the challenge the page was opened with. */
  pkceVerified: boolean;
  readonly mints: MintRequest[];
  getMes: number;
  /** Any other request, as `<method> <path>`. */
  readonly unexpected: string[];
}

export interface MockBackend {
  /** `http://127.0.0.1:<port>`: the backend and the website alike. */
  readonly url: string;
  readonly port: number;
  readonly seen: MockObservations;
  /** Holds the next `CreateUserApiKey` until the returned release is called; `arrived` settles when it comes in. */
  holdMint(): { readonly arrived: Promise<void>; readonly release: () => void };
  /** Forgets what it saw and every held mint. */
  reset(): void;
  close(): Promise<void>;
}

function base64url(bytes: Buffer): string {
  return bytes.toString("base64").replaceAll("+", "-").replaceAll("/", "_").replaceAll("=", "");
}

function varint(value: number): Buffer {
  const bytes: number[] = [];
  let rest = value;
  while (rest >= 0x80) {
    bytes.push((rest % 0x80) + 0x80);
    rest = Math.floor(rest / 0x80);
  }
  bytes.push(rest);
  return Buffer.from(bytes);
}

/** One protobuf string field. */
function stringField(field: number, value: string): Buffer {
  const bytes = Buffer.from(value, "utf8");
  return Buffer.concat([varint(field * 8 + 2), varint(bytes.length), bytes]);
}

/** The varint and length-delimited fields of a protobuf message, by field number (enough for the requests above). */
function decodeFields(message: Buffer): Map<number, number | Buffer> {
  const fields = new Map<number, number | Buffer>();
  let offset = 0;
  const readVarint = (): number => {
    let value = 0;
    let scale = 1;
    for (;;) {
      const byte = message[offset];
      if (byte === undefined) {
        throw new Error("truncated protobuf varint");
      }
      offset += 1;
      value += (byte % 0x80) * scale;
      scale *= 0x80;
      if (byte < 0x80) {
        return value;
      }
    }
  };
  while (offset < message.length) {
    const tag = readVarint();
    const field = Math.floor(tag / 8);
    const wireType = tag % 8;
    if (wireType === 0) {
      fields.set(field, readVarint());
    } else if (wireType === 2) {
      const length = readVarint();
      fields.set(field, message.subarray(offset, offset + length));
      offset += length;
    } else {
      throw new Error(`unexpected protobuf wire type ${String(wireType)}`);
    }
  }
  return fields;
}

async function body(request: IncomingMessage): Promise<Buffer> {
  const chunks: Buffer[] = [];
  for await (const chunk of request) {
    chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(String(chunk)));
  }
  return Buffer.concat(chunks);
}

function proto(response: ServerResponse, message: Buffer): void {
  response.writeHead(200, { "content-type": "application/proto" });
  response.end(message);
}

export async function startMockBackend(): Promise<MockBackend> {
  const seen: MockObservations = { polls: 0, getPolls: 0, pkceVerified: false, mints: [], getMes: 0, unexpected: [] };
  /** Opened pages: uuid → challenge. */
  const signedIn = new Map<string, string>();
  const mintHold: { held?: { readonly arrived: PromiseWithResolvers<void>; readonly released: PromiseWithResolvers<void> } } = {};

  const poll = async (request: IncomingMessage, response: ServerResponse): Promise<void> => {
    seen.polls += 1;
    const raw = await body(request);
    const parsed: unknown = JSON.parse(raw.toString("utf8"));
    const uuid = typeof parsed === "object" && parsed !== null && "uuid" in parsed && typeof parsed.uuid === "string" ? parsed.uuid : "";
    const verifier = typeof parsed === "object" && parsed !== null && "verifier" in parsed && typeof parsed.verifier === "string" ? parsed.verifier : "";
    const challenge = signedIn.get(uuid);
    if (challenge === undefined) {
      response.writeHead(404, { "content-type": "text/plain" });
      response.end("Not found");
      return;
    }
    seen.pkceVerified = base64url(createHash("sha256").update(verifier).digest()) === challenge;
    response.writeHead(seen.pkceVerified ? 200 : 403, { "content-type": "application/json" });
    response.end(JSON.stringify(seen.pkceVerified ? { accessToken: ACCESS_TOKEN, refreshToken: REFRESH_TOKEN } : { error: "challenge mismatch" }));
  };

  const mint = async (request: IncomingMessage, response: ServerResponse): Promise<void> => {
    const fields = decodeFields(await body(request));
    const name = fields.get(1);
    const expires = fields.get(3);
    seen.mints.push({
      name: Buffer.isBuffer(name) ? name.toString("utf8") : "",
      expiresAtMs: typeof expires === "number" ? expires : undefined,
      bearer: request.headers.authorization === `Bearer ${ACCESS_TOKEN}`,
    });
    const hold = mintHold.held;
    if (hold !== undefined) {
      delete mintHold.held;
      hold.arrived.resolve();
      await hold.released.promise;
    }
    proto(response, stringField(1, MOCK_KEY));
  };

  const server = createServer((request, response) => {
    const url = new URL(request.url ?? "/", "http://127.0.0.1");
    const route = `${request.method ?? "GET"} ${url.pathname}`;
    const handle = async (): Promise<void> => {
      if (route === "GET /loginDeepControl") {
        signedIn.set(url.searchParams.get("uuid") ?? "", url.searchParams.get("challenge") ?? "");
        response.writeHead(200, { "content-type": "text/plain" });
        response.end("signed in");
        return;
      }
      if (route === "POST /auth/poll") {
        await poll(request, response);
        return;
      }
      if (route === "GET /auth/poll") {
        seen.getPolls += 1;
        response.writeHead(404, { "content-type": "text/plain" });
        response.end("Not found");
        return;
      }
      if (route === `POST ${SERVICE}CreateUserApiKey`) {
        await mint(request, response);
        return;
      }
      if (route === `POST ${SERVICE}GetMe`) {
        seen.getMes += 1;
        await body(request);
        proto(response, Buffer.concat([stringField(1, "mock-auth-id"), stringField(3, MOCK_EMAIL)]));
        return;
      }
      seen.unexpected.push(route);
      await body(request);
      response.writeHead(404, { "content-type": "application/json" });
      response.end(JSON.stringify({ code: "not_found", message: `the mock backend does not serve ${route}` }));
    };
    void (async (): Promise<void> => {
      try {
        await handle();
      } catch (error) {
        seen.unexpected.push(`${route} (failed: ${error instanceof Error ? error.message : String(error)})`);
        response.destroy();
      }
    })();
  });
  const listening = Promise.withResolvers<void>();
  server.once("error", listening.reject);
  server.listen(0, "127.0.0.1", listening.resolve);
  await listening.promise;
  const address = server.address();
  if (address === null || typeof address === "string") {
    throw new Error("the mock backend has no TCP address");
  }
  const { port } = address;
  return {
    url: `http://127.0.0.1:${String(port)}`,
    port,
    seen,
    holdMint() {
      const hold = { arrived: Promise.withResolvers<void>(), released: Promise.withResolvers<void>() };
      mintHold.held = hold;
      return { arrived: hold.arrived.promise, release: hold.released.resolve };
    },
    reset() {
      Object.assign(seen, { polls: 0, getPolls: 0, pkceVerified: false, getMes: 0 });
      seen.mints.length = 0;
      seen.unexpected.length = 0;
      signedIn.clear();
      mintHold.held?.released.resolve();
      delete mintHold.held;
    },
    async close() {
      mintHold.held?.released.resolve();
      server.closeAllConnections();
      const closed = Promise.withResolvers<void>();
      server.close(() => {
        closed.resolve();
      });
      await closed.promise;
    },
  };
}
