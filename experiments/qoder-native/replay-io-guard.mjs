/* oxlint-disable typescript/no-unsafe-assignment, typescript/no-unsafe-member-access, typescript/no-unsafe-call, typescript/no-unsafe-argument, typescript/no-unsafe-return, typescript/strict-boolean-expressions -- Standalone Node preload observes overloaded file/socket APIs in the native process without a TypeScript loader. */
// Account-free probe guard: allow local IPC, refuse non-loopback sockets,
// and record whether the unmodified native binary reads the replay file.
import fs from "node:fs";
import net from "node:net";
import { syncBuiltinESMExports } from "node:module";

const replay = process.env.OAR_QODER_PROBE_REPLAY;
const output = process.env.OAR_QODER_PROBE_IO;
function observe(kind) {
  if (output) { fs.appendFileSync(output, `${JSON.stringify({ kind })}\n`); }
}
function isReplay(value) {
  return String(value) === replay;
}
for (const name of ["readFile", "readFileSync", "createReadStream", "open", "openSync"]) {
  const original = fs[name];
  fs[name] = function observedFileRead(...args) {
    if (isReplay(args[0])) { observe("replay_read"); }
    return Reflect.apply(original, this, args);
  };
}
for (const name of ["readFile", "open"]) {
  const original = fs.promises[name];
  fs.promises[name] = function observedAsyncFileRead(...args) {
    if (isReplay(args[0])) { observe("replay_read"); }
    return Reflect.apply(original, this, args);
  };
}
const originalConnect = net.Socket.prototype.connect;
net.Socket.prototype.connect = function connect(...args) {
  // Node can pass an already normalized [options, callback] tuple.
  const call = Array.isArray(args[0]) ? args[0] : args;
  const [first] = call;
  const options = first !== null && typeof first === "object" ? first : undefined;
  const localPath = options?.path ?? (typeof first === "string" && !/^\d+$/u.test(first) ? first : undefined);
  const host = options?.host ?? (typeof call[1] === "string" ? call[1] : "localhost");
  if (localPath === undefined && !["localhost", "127.0.0.1", "::1", "[::1]"].includes(host)) {
    observe("external_socket_blocked");
    throw new Error("OAR native replay probe permits loopback connections only");
  }
  return Reflect.apply(originalConnect, this, args);
};
syncBuiltinESMExports();
observe("guard_loaded");
