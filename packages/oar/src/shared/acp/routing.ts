import { RequestError, type JsonRpcId } from "@agentclientprotocol/sdk";
import { UnsupportedOptionError } from "../../contracts/errors.js";
import { SessionUnavailableError } from "../../contracts/session-unavailable-error.js";
import type { CredentialRedactor } from "../credential-redactor.js";
import { asRecord, type JsonRecord } from "../json.js";
import { redactText } from "../redact-text.js";
import { redactTokenShapes } from "../token-redaction.js";

export interface AcpAssociation { readonly parent: string; readonly child: string }
export interface AcpIngress { readonly receivedAt: number; readonly afterOpen: boolean }
export interface AcpUnattributed {
  readonly method: string;
  readonly params: unknown;
  readonly receivedAt: number;
  readonly reason: "expired" | "capacity" | "retired" | "unowned" | "conflict" | "connection_closed";
}

export interface AcpOwner<T> {
  readonly target: T;
  /** Reserve resume/load before sending, or bind only the id returned by session/new. */
  bind(id: string): void;
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
  opened(id: string): void;
  retired(id: string): boolean;
  attach(target: T, credentials: CredentialRedactor): AcpOwner<T>;
  notify(method: string, params: unknown, deliver: (target: T, ingress: AcpIngress) => void): void;
  request(method: string, params: unknown, requestId?: JsonRpcId): Promise<{ readonly target: T; readonly ingress: AcpIngress; readonly active: () => boolean }>;
  diagnostic(method: string, params: unknown, reason?: AcpUnattributed["reason"]): void;
  close(): void;
}

interface Owner<T> { requests: boolean; readonly target: T; readonly credentials: CredentialRedactor; readonly ids: Set<string>; opened: number | null; disposed: boolean }
interface Pending<T> {
  readonly id: string;
  readonly links: readonly AcpAssociation[];
  readonly bytes: number;
  readonly sequence: number;
  readonly diagnostic: Omit<AcpUnattributed, "reason">;
  readonly deliver: (owner: Owner<T>, ingress: AcpIngress) => void;
  readonly reject: (reason: AcpUnattributed["reason"]) => void;
  readonly timer: ReturnType<typeof setTimeout>;
}

/** Connection-local ownership, independent of sessions' kernels and native request-id allocation. */
export function createAcpRouting<T>(options: {
  readonly associations?: (method: string, params: JsonRecord) => readonly AcpAssociation[];
  readonly sessionId?: (method: string, params: JsonRecord) => string | null;
  readonly diagnostic: (entry: AcpUnattributed) => void;
  readonly maxFrames?: number;
  readonly maxBytes?: number;
  readonly waitMs?: number;
}): AcpRouting<T> {
  const owners = new Set<Owner<T>>();
  // Native work may outlive disposal. Retain only redactors, not session targets, until exit.
  const redactors = new Set<CredentialRedactor>();
  const ids = new Map<string, Owner<T> | null>();
  const pending = new Set<Pending<T>>();
  const received = new WeakMap<object, { readonly time: number; readonly sequence: number }>();
  const requestIngress = new Map<JsonRpcId, { readonly time: number; readonly sequence: number }>();
  const opened = new Map<string, number>();
  let sequence = 0;
  let bytes = 0;
  let closed = false;
  const redact = (text: string): string => {
    let result = text;
    for (const credentials of redactors) { result = credentials.redact(result); }
    return redactTokenShapes(result);
  };
  const safe = <V>(value: V): V => redactText(value, redact, (text) => redact(text) !== text);
  const report = (entry: Omit<AcpUnattributed, "reason">, reason: AcpUnattributed["reason"]): void => {
    // Diagnostics are a side tap. They must not prevent rejecting a host request.
    try { options.diagnostic(safe({ ...entry, reason })); } catch { /* Observer failure is isolated. */ }
  };
  const remove = (entry: Pending<T>): void => { pending.delete(entry); bytes -= entry.bytes; clearTimeout(entry.timer); };
  const discard = (entry: Pending<T>, reason: AcpUnattributed["reason"]): void => {
    remove(entry); report(entry.diagnostic, reason); entry.reject(reason);
  };
  const link = (links: readonly AcpAssociation[], diagnostic: Omit<AcpUnattributed, "reason">): boolean => {
    let changed = false;
    for (const relation of links) {
      const parent = ids.get(relation.parent);
      if (parent === undefined || parent === null || parent.disposed || relation.parent === relation.child) { continue; }
      if (ids.has(relation.child)) {
        if (ids.get(relation.child) !== parent) { report(diagnostic, "conflict"); }
      } else { ids.set(relation.child, parent); parent.ids.add(relation.child); changed = true; }
    }
    return changed;
  };
  const flush = (): void => {
    let changed = true;
    while (changed) {
      changed = false;
      for (const entry of pending) { changed = link(entry.links, entry.diagnostic) || changed; }
    }
    for (const entry of pending) {
      const owner = ids.get(entry.id);
      if (owner === null) { discard(entry, "retired"); }
      else if (owner !== undefined && !owner.disposed) {
        remove(entry);
        entry.deliver(owner, { receivedAt: entry.diagnostic.receivedAt, afterOpen: owner.opened !== null && entry.sequence > owner.opened });
      }
    }
  };
  const bind = (owner: Owner<T>, id: string): void => {
    if (closed || owner.disposed || id.length === 0) { throw new Error("ACP ownership is closed or the native session id is empty"); }
    const controller = ids.get(id);
    if (controller === null) {
      throw new UnsupportedOptionError("placement", "ACP native session id is retired on this shared connection; resume requires an isolated process");
    }
    if (controller !== undefined && controller !== owner) {
      throw new SessionUnavailableError(id, "ACP native session id is already controlled on this connection", {
        reason: "in_use", method: "oar/open", native: { sessionId: id },
      });
    }
    ids.set(id, owner); owner.ids.add(id); owner.opened ??= opened.get(id) ?? null; flush();
  };
  const associate = (method: string, params: JsonRecord, ingress: Omit<AcpUnattributed, "reason">): void => {
    const links = options.associations?.(method, params) ?? [];
    while (link(links, ingress)) { /* Follow explicit multi-level links to their root. */ }
    flush();
  };
  const route = (method: string, params: unknown, deliver: Pending<T>["deliver"], refuse: Pending<T>["reject"], requestId?: JsonRpcId): void => {
    const record = asRecord(params);
    const metadata = requestId === undefined ? (record === null ? undefined : received.get(record)) : requestIngress.get(requestId);
    if (requestId !== undefined) { requestIngress.delete(requestId); }
    const receivedAt = metadata?.time ?? Date.now();
    const frameSequence = metadata?.sequence ?? ++sequence;
    // Capture redaction while all leases present at ingress still own their credentials.
    const diagnostic = safe({ method, params, receivedAt });
    if (closed) { report(diagnostic, "connection_closed"); refuse("connection_closed"); return; }
    if (record !== null) { associate(method, record, diagnostic); }
    const defaultId = typeof record?.sessionId === "string" ? record.sessionId : null;
    const id = record === null || options.sessionId === undefined ? defaultId : options.sessionId(method, record);
    if (id === null || id === "") { report(diagnostic, "unowned"); refuse("unowned"); return; }
    const owner = ids.get(id);
    if (owner === null) { report(diagnostic, "retired"); refuse("retired"); return; }
    if (owner !== undefined && !owner.disposed) { deliver(owner, { receivedAt, afterOpen: owner.opened !== null && frameSequence > owner.opened }); return; }
    const size = Buffer.byteLength(JSON.stringify(params));
    const capacity = options.maxBytes ?? 1024 * 1024;
    const maxFrames = options.maxFrames ?? 256;
    if (size > capacity || maxFrames < 1) { report(diagnostic, "capacity"); refuse("capacity"); return; }
    for (const entry of pending) {
      if (pending.size < maxFrames && bytes + size <= capacity) { break; }
      discard(entry, "capacity");
    }
    const timer = setTimeout(() => { discard(entry, "expired"); }, options.waitMs ?? 1000);
    timer.unref();
    const links = record === null ? [] : options.associations?.(method, record) ?? [];
    const entry: Pending<T> = { id, links, sequence: frameSequence, bytes: size, diagnostic, deliver, reject: refuse, timer };
    pending.add(entry); bytes += size;
  };
  return {
    redact,
    redactValue: safe,
    ingress(params, requestId): void {
      const metadata = { time: Date.now(), sequence: ++sequence };
      received.set(params, metadata);
      if (requestId !== undefined) {
        requestIngress.set(requestId, metadata);
        if (requestIngress.size > (options.maxFrames ?? 256)) {
          const oldest = requestIngress.keys().next();
          if (oldest.done !== true) { requestIngress.delete(oldest.value); }
        }
      }
    },
    answered(requestId): void { requestIngress.delete(requestId); },
    opened(id): void {
      const position = ++sequence;
      opened.set(id, position);
      const owner = ids.get(id);
      if (owner !== undefined && owner !== null) { owner.opened = position; }
    },
    retired(id): boolean { return ids.get(id) === null; },
    attach(target: T, credentials: CredentialRedactor): AcpOwner<T> {
      const owner: Owner<T> = { requests: true, target, credentials, ids: new Set(), opened: null, disposed: false };
      owners.add(owner); redactors.add(credentials);
      return {
        target,
        bind: (id) => { bind(owner, id); },
        opened: () => { owner.opened ??= ++sequence; },
        stopRequests(): void { owner.requests = false; },
        associations(method, params): readonly AcpAssociation[] {
          return (options.associations?.(method, params) ?? []).filter(({ parent, child }) => ids.get(parent) === owner && ids.get(child) === owner);
        },
        dispose() {
          if (owner.disposed) { return; }
          owner.disposed = true;
          for (const id of owner.ids) { ids.set(id, null); }
          flush(); owners.delete(owner);
        },
      };
    },
    notify(method: string, params: unknown, deliver: (target: T, ingress: AcpIngress) => void): void {
      route(method, params, (owner, ingress) => { deliver(owner.target, ingress); }, () => {});
    },
    async request(method: string, params: unknown, requestId?: JsonRpcId): Promise<{ readonly target: T; readonly ingress: AcpIngress; readonly active: () => boolean }> {
      const answer = await new Promise<{ readonly target: T; readonly ingress: AcpIngress; readonly active: () => boolean }>((resolve, reject) => {
        route(method, params, (owner, ingress) => {
          if (!owner.requests || owner.disposed) { reject(RequestError.invalidParams(undefined, "ACP native session no longer accepts host requests")); return; }
          resolve({ target: owner.target, ingress, active: () => owner.requests && !owner.disposed });
        }, () => {
          reject(RequestError.invalidParams(undefined, "ACP host request has no active native session owner"));
        }, requestId);
      });
      return answer;
    },
    diagnostic(method, params, reason = "unowned"): void { report({ method, params, receivedAt: Date.now() }, reason); },
    close(): void {
      closed = true; requestIngress.clear();
      for (const entry of pending) { discard(entry, "connection_closed"); }
      for (const owner of owners) { owner.disposed = true; }
      owners.clear(); ids.clear(); opened.clear();
    },
  };
}
