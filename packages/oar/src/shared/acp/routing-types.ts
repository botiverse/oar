import type { JsonRpcId } from "@agentclientprotocol/sdk";
import type { CredentialRedactor } from "../credential-redactor.js";
import type { JsonRecord } from "../json.js";

export interface AcpAssociation { readonly parent: string; readonly child: string }
export interface AcpIngress { readonly receivedAt: number; readonly afterOpen: boolean }
export interface AcpUnattributed {
  readonly method: string;
  readonly params: unknown;
  readonly receivedAt: number;
  readonly reason: "expired" | "capacity" | "retired" | "unowned" | "conflict" | "connection_closed" | "pre_reservation";
}

export interface AcpOwner<T> {
  readonly target: T;
  /** Bind only the id returned by session/new. Collisions are protocol violations. */
  bind(id: string): void;
  /** Reserve resume/load before sending; earlier buffered traffic has no proven generation. */
  reserve(id: string): void;
  opened(): void;
  stopRequests(): void;
  associations(method: string, params: JsonRecord): readonly AcpAssociation[];
  /** Retire every root/descendant id for this connection's lifetime. No guessed generations. */
  dispose(): void;
}

export interface AcpRouting<T> {
  redact(this: void, text: string): string;
  redactValue<V>(this: void, value: V): V;
  ingress(params: object, requestId?: JsonRpcId): void;
  answered(requestId: JsonRpcId): void;
  opened(id: string, resumed: boolean): void;
  newStarted(requestId: JsonRpcId): void;
  newFinished(requestId: JsonRpcId): void;
  retired(id: string): boolean;
  inUse(id: string): boolean;
  retireUnowned(id: string): boolean;
  attach(target: T, credentials: CredentialRedactor): AcpOwner<T>;
  notify(method: string, params: unknown, deliver: (target: T, ingress: AcpIngress) => void): void;
  request(method: string, params: unknown, requestId?: JsonRpcId): Promise<{ readonly target: T; readonly ingress: AcpIngress; readonly active: () => boolean }>;
  diagnostic(method: string, params: unknown, reason?: AcpUnattributed["reason"]): void;
  close(): void;
}

