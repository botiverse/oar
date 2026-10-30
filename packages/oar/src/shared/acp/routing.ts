import { RequestError, type JsonRpcId } from "@agentclientprotocol/sdk";
import { UnsupportedOptionError } from "../../contracts/errors.js";
import { SessionUnavailableError } from "../../contracts/session-unavailable-error.js";
import type { CredentialRedactor } from "../credential-redactor.js";
import { asRecord, type JsonRecord } from "../json.js";
import { redactText } from "../redact-text.js";
import { redactTokenShapes } from "../token-redaction.js";
import { AcpProtocolError } from "./protocol-error.js";

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
  retireUnowned(id: string): boolean;
  attach(target: T, credentials: CredentialRedactor): AcpOwner<T>;
  notify(method: string, params: unknown, deliver: (target: T, ingress: AcpIngress) => void): void;
  request(method: string, params: unknown, requestId?: JsonRpcId): Promise<{ readonly target: T; readonly ingress: AcpIngress; readonly active: () => boolean }>;
  diagnostic(method: string, params: unknown, reason?: AcpUnattributed["reason"]): void;
  close(): void;
}

interface Owner<T> { requests: boolean; readonly target: T; readonly ids: Set<string>; opened: number | null; reserved: number | null; disposed: boolean }
interface Pending<T> {
  readonly id: string;
  links: readonly AcpAssociation[];
  readonly bytes: number;
  readonly sequence: number;
  readonly diagnostic: Omit<AcpUnattributed, "reason">;
  readonly deliver: (owner: Owner<T>, ingress: AcpIngress) => void;
  readonly reject: (reason: AcpUnattributed["reason"]) => void;
  conflictReported: boolean;
  delivered: boolean;
  timer: ReturnType<typeof setTimeout> | null;
}

function beforeReservation<T>(owner: Owner<T>, position: number): boolean { return owner.reserved !== null && position < owner.reserved; }

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
  const redactors = new Map<CredentialRedactor, readonly string[]>();
  let credentialValues: readonly string[] = [];
  let credentialsChanged = false;
  const ids = new Map<string, Owner<T> | null>();
  const pending = new Set<Pending<T>>();
  const newRequests = new Set<JsonRpcId>();
  const received = new WeakMap<object, { readonly time: number; readonly sequence: number }>();
  const requestIngress = new Map<JsonRpcId, { readonly time: number; readonly sequence: number }>();
  const opened = new Map<string, number>();
  const reserved = new Map<string, number>();
  let sequence = 0;
  let bytes = 0;
  let closed = false;
  const redact = (text: string): string => {
    // Merge before replacing: a shorter peer credential must not expose the tail of a longer one.
    for (const [credentials, previous] of redactors) {
      const values = credentials.values();
      if (values !== previous) { redactors.set(credentials, values); credentialsChanged = true; }
    }
    if (credentialsChanged) {
      credentialValues = [...new Set([...redactors.values()].flat())].toSorted((a, b) => b.length - a.length);
      credentialsChanged = false;
    }
    return redactTokenShapes(credentialValues.reduce((result, value) => result.replaceAll(value, "[redacted]"), text));
  };
  const safe = <V>(value: V): V => redactText(value, redact, (text) => redact(text) !== text);
  const report = (entry: Omit<AcpUnattributed, "reason">, reason: AcpUnattributed["reason"]): void => {
    try { options.diagnostic(safe({ ...entry, reason })); } catch { /* Observer failure is isolated. */ }
  };
  const remove = (entry: Pending<T>): void => {
    pending.delete(entry); bytes -= entry.bytes;
    if (entry.timer !== null) { clearTimeout(entry.timer); entry.timer = null; }
  };
  const discard = (entry: Pending<T>, reason: AcpUnattributed["reason"]): void => {
    remove(entry); report(entry.diagnostic, reason);
    if (!entry.delivered) { entry.reject(reason); }
  };
  const arm = (entry: Pending<T>): void => {
    if (newRequests.size > 0) { return; }
    entry.timer = setTimeout(() => { discard(entry, "expired"); }, options.waitMs ?? 1000);
    entry.timer.unref();
  };
  const conflict = (entry: Pending<T>): void => {
    if (!entry.conflictReported) { entry.conflictReported = true; report(entry.diagnostic, "conflict"); }
  };
  const link = (entry: Pending<T>): boolean => {
    const carrier = ids.get(entry.id);
    if (carrier === undefined || carrier === null || carrier.disposed) { return false; }
    let changed = false;
    const unresolved: AcpAssociation[] = [];
    for (const relation of entry.links) {
      const parent = ids.get(relation.parent);
      // A frame may prove links only within its carrier's already established root.
      if (relation.parent === relation.child) { conflict(entry); continue; }
      if (parent === undefined) { unresolved.push(relation); continue; }
      if (parent !== carrier) { conflict(entry); continue; }
      if (ids.has(relation.child)) {
        if (ids.get(relation.child) !== carrier) { conflict(entry); }
      } else { ids.set(relation.child, carrier); carrier.ids.add(relation.child); changed = true; }
    }
    entry.links = unresolved;
    return changed;
  };
  const flush = (): void => {
    let changed = true;
    while (changed) {
      changed = false;
      for (const entry of pending) {
        const owner = ids.get(entry.id);
        if (owner === null) { discard(entry, "retired"); }
        else if (owner !== undefined && beforeReservation(owner, entry.sequence)) { discard(entry, "pre_reservation"); }
        else { changed = link(entry) || changed; }
      }
    }
    for (const entry of pending) {
      const owner = ids.get(entry.id);
      if (owner === null) { discard(entry, "retired"); }
      else if (owner !== undefined && !owner.disposed) {
        if (!entry.delivered) {
          entry.delivered = true;
          entry.deliver(owner, { receivedAt: entry.diagnostic.receivedAt, afterOpen: owner.opened !== null && entry.sequence > owner.opened });
        }
        if (entry.links.length === 0) { remove(entry); }
      }
    }
  };
  const bind = (owner: Owner<T>, id: string, resume: boolean): void => {
    if (closed || owner.disposed) { throw new Error("ACP ownership is closed"); }
    if (id.length === 0) {
      if (resume) { throw new TypeError("ACP resume requires a nonempty session id"); }
      throw new AcpProtocolError("ACP session/new returned an empty native session id");
    }
    const controller = ids.get(id);
    if (controller !== undefined && controller !== owner) {
      if (!resume) { throw new AcpProtocolError("ACP session/new returned an owned or retired native session id"); }
      if (controller === null) { throw new UnsupportedOptionError("placement", "ACP native session id is retired on this shared connection; resume requires an isolated process"); }
      throw new SessionUnavailableError(id, "ACP native session id is already controlled on this connection", { reason: "in_use", method: "oar/open", native: { sessionId: id } });
    }
    if (resume) {
      owner.reserved = ++sequence; reserved.set(id, owner.reserved);
      for (const entry of pending) { if (entry.id === id) { discard(entry, "pre_reservation"); } }
      opened.delete(id);
    }
    if (controller === owner) { return; }
    ids.set(id, owner); owner.ids.add(id); owner.opened ??= opened.get(id) ?? null; flush();
  };
  const buffer = (entry: Pending<T>): void => {
    const capacity = options.maxBytes ?? 1024 * 1024;
    const maxFrames = options.maxFrames ?? 256;
    if (entry.bytes > capacity || maxFrames < 1) {
      report(entry.diagnostic, "capacity"); if (!entry.delivered) { entry.reject("capacity"); } return;
    }
    for (const old of pending) {
      if (pending.size < maxFrames && bytes + entry.bytes <= capacity) { break; }
      discard(old, "capacity");
    }
    pending.add(entry); bytes += entry.bytes; arm(entry);
  };
  const route = (method: string, params: unknown, deliver: Pending<T>["deliver"], refuse: Pending<T>["reject"], requestId?: JsonRpcId): void => {
    const record = asRecord(params);
    const metadata = requestId === undefined ? (typeof params === "object" && params !== null ? received.get(params) : undefined) : requestIngress.get(requestId);
    if (requestId !== undefined) { requestIngress.delete(requestId); }
    const receivedAt = metadata?.time ?? Date.now();
    const frameSequence = metadata?.sequence ?? ++sequence;
    const diagnostic = safe({ method, params, receivedAt });
    if (closed) { report(diagnostic, "connection_closed"); refuse("connection_closed"); return; }
    const defaultId = typeof record?.sessionId === "string" ? record.sessionId : null;
    const id = record === null || options.sessionId === undefined ? defaultId : options.sessionId(method, record);
    if (id === null || id === "") { report(diagnostic, "unowned"); refuse("unowned"); return; }
    const owner = ids.get(id);
    const reservation = reserved.get(id);
    if ((reservation !== undefined && frameSequence < reservation) || (owner !== undefined && owner !== null && beforeReservation(owner, frameSequence))) {
      report(diagnostic, "pre_reservation"); refuse("pre_reservation"); return;
    }
    if (owner === null) { report(diagnostic, "retired"); refuse("retired"); return; }
    const size = Buffer.byteLength(JSON.stringify(params));
    const entry: Pending<T> = { id, links: record === null ? [] : options.associations?.(method, record) ?? [], bytes: size,
      sequence: frameSequence, diagnostic, deliver, reject: refuse, timer: null, conflictReported: false, delivered: false };
    if (owner !== undefined && !owner.disposed) {
      const changed = link(entry); entry.delivered = true;
      if (entry.links.length > 0) { buffer(entry); }
      if (changed) { flush(); }
      deliver(owner, { receivedAt, afterOpen: owner.opened !== null && frameSequence > owner.opened }); return;
    }
    buffer(entry);
  };
  return {
    redact, redactValue: safe,
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
    opened(id, resumed): void {
      const position = ++sequence;
      if (!resumed && ids.has(id)) { return; }
      opened.set(id, position);
      const owner = ids.get(id);
      if (owner !== undefined && owner !== null) { owner.opened = position; }
    },
    newStarted(requestId): void {
      newRequests.add(requestId);
      for (const entry of pending) { if (entry.timer !== null) { clearTimeout(entry.timer); entry.timer = null; } }
    },
    newFinished(requestId): void {
      if (!newRequests.delete(requestId) || newRequests.size > 0) { return; }
      // Give the SDK's asynchronous response dispatch time to bind before expiring unknown ids.
      for (const entry of pending) { arm(entry); }
    },
    retired(id): boolean { return ids.get(id) === null; },
    retireUnowned(id): boolean {
      const owner = ids.get(id);
      if (owner !== undefined) { return false; }
      ids.set(id, null); opened.delete(id); reserved.delete(id); flush(); return true;
    },
    attach(target: T, credentials: CredentialRedactor): AcpOwner<T> {
      const owner: Owner<T> = { requests: true, target, ids: new Set(), opened: null, reserved: null, disposed: false };
      owners.add(owner); redactors.set(credentials, credentials.values()); credentialsChanged = true;
      return {
        target, bind: (id) => { bind(owner, id, false); }, reserve: (id) => { bind(owner, id, true); },
        opened: () => { owner.opened ??= ++sequence; },
        stopRequests(): void { owner.requests = false; },
        associations(method, params): readonly AcpAssociation[] {
          const id = options.sessionId === undefined ? params.sessionId : options.sessionId(method, params);
          if (typeof id !== "string" || ids.get(id) !== owner) { return []; }
          return (options.associations?.(method, params) ?? []).filter(({ parent, child }) => ids.get(parent) === owner && ids.get(child) === owner);
        },
        dispose() {
          if (owner.disposed) { return; }
          owner.disposed = true;
          for (const id of owner.ids) { ids.set(id, null); opened.delete(id); reserved.delete(id); }
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
        }, () => { reject(RequestError.invalidParams(undefined, "ACP host request has no active native session owner")); }, requestId);
      });
      return answer;
    },
    diagnostic(method, params, reason = "unowned"): void { report({ method, params, receivedAt: Date.now() }, reason); },
    close(): void {
      closed = true; requestIngress.clear(); newRequests.clear();
      for (const entry of pending) { discard(entry, "connection_closed"); }
      for (const owner of owners) { owner.disposed = true; }
      owners.clear(); ids.clear(); opened.clear(); reserved.clear();
    },
  };
}
