/* oxlint-disable eslint/max-statements, eslint/max-lines-per-function, eslint/complexity, typescript/no-unsafe-assignment, typescript/no-unsafe-member-access, typescript/no-unsafe-call, typescript/no-unsafe-return, typescript/no-unsafe-argument, typescript/strict-boolean-expressions -- Standalone untyped fixture executable. */
import { createHash } from "node:crypto";

export function makeWsFrame(socket, obj) {
  const payload = Buffer.from(JSON.stringify(obj), "utf8");
  const len = payload.length;
  const header = len < 126 ? Buffer.from([0x81, len]) : Buffer.from([0x81, 126, (len >> 8) & 0xFF, len & 0xFF]);
  socket.write(Buffer.concat([header, payload]));
}

function readWsPacket(buffer, offset) {
  const opcode = buffer[offset] & 0x0F;
  const masked = (buffer[offset + 1] & 0x80) !== 0;
  let len = buffer[offset + 1] & 0x7F;
  let cursor = offset + 2;
  if (len === 126) {
    if (cursor + 2 > buffer.length) { return null; }
    len = buffer.readUInt16BE(cursor);
    cursor += 2;
  }
  const maskLen = masked ? 4 : 0;
  if (cursor + maskLen + len > buffer.length) { return null; }
  const mask = masked ? buffer.subarray(cursor, cursor + 4) : null;
  const payload = Buffer.from(buffer.subarray(cursor + maskLen, cursor + maskLen + len));
  if (mask) {
    for (let i = 0; i < payload.length; i += 1) { payload[i] ^= mask[i % 4]; }
  }
  return { opcode, text: payload.toString("utf8"), nextOffset: cursor + maskLen + len };
}

function decodeWsFrames(buffer) {
  const frames = [];
  let offset = 0;
  while (offset + 2 <= buffer.length) {
    const pkt = readWsPacket(buffer, offset);
    if (pkt === null) { break; }
    frames.push({ opcode: pkt.opcode, text: pkt.text });
    offset = pkt.nextOffset;
  }
  return { frames, rest: buffer.subarray(offset) };
}

function sendUpgradeResponse(socket, key, bearer) {
  const accept = createHash("sha1").update(`${key}258EAFA5-E914-47DA-95CA-C5AB0DC85B11`).digest("base64");
  socket.write(
    `HTTP/1.1 101 Switching Protocols\r\nUpgrade: websocket\r\nConnection: Upgrade\r\nSec-WebSocket-Accept: ${accept}\r\nSec-WebSocket-Protocol: kimi-code.bearer.${bearer}\r\n\r\n`,
  );
}

function sendSubscribeAgent({ socket, msg, opts, now }) {
  const [first] = [...opts.sessions.values()];
  const model = opts.scenario === "wrong_model" ? "wrong-model" : (first?.model ?? "default-model");
  const agent = { type: "agent", session_id: msg.session_id, agent_id: "main", event_created_at: now, status: "idle", compacting: false, model, plan_mode: false, swarm_mode: false, tower_mode: false };
  if (opts.scenario !== "omit_effort") {
    agent.thinking = opts.scenario === "wrong_effort" ? "low" : (first?.thinking ?? "off");
  }
  makeWsFrame(socket, agent);
}

function initialBaseTurns(opts) {
  if (opts.scenario === "resume_history") {
    return [{ turn_id: "old-turn-1", ordinal: 0, kind: "agent", status: "ended", outcome: "completed", items: [{ type: "assistant_message", item_id: "old-am-1", status: "ended", text: "historical-text" }] }];
  }
  if (opts.scenario === "initial_running_turn") {
    if (opts.state) {
      opts.state.activeTurnId = "live-open-turn-1";
      opts.state.activePromptId = "p-live-1";
    }
    return [{ turn_id: "live-open-turn-1", ordinal: 0, kind: "agent", status: "running", items: [{ type: "user_message", item_id: "um-live-1", status: "ended", prompt_ids: ["p-live-1"], text: "in-flight" }] }];
  }
  return [];
}

function handleClientMsg(socket, msg, opts) {
  if (msg.type === "subscribe") {
    const now = new Date().toISOString();
    sendSubscribeAgent({ socket, msg, opts, now });
    if (opts.scenario === "turns_failed_on_open") {
      makeWsFrame(socket, { type: "turns.failed", session_id: msg.session_id, agent_id: "main", event_created_at: now, code: 50_001, msg: "Failed to load initial turns" });
      makeWsFrame(socket, { type: "response", request_id: msg.request_id, code: 0, msg: "ok" });
      return;
    }
    const baseTurns = initialBaseTurns(opts);
    const sendTurns = () => {
      const turns = [...baseTurns, ...(opts.state?.liveTurns ?? [])];
      makeWsFrame(socket, { type: "turns", session_id: msg.session_id, agent_id: "main", event_created_at: now, turns, has_more: false });
    };
    if (opts.scenario === "delayed_initial_turns") {
      makeWsFrame(socket, { type: "response", request_id: msg.request_id, code: 0, msg: "ok" });
      setTimeout(sendTurns, 60);
      return;
    }
    sendTurns();
    makeWsFrame(socket, { type: "response", request_id: msg.request_id, code: 0, msg: "ok" });
    return;
  }
  if (msg.type === "task.stop") {
    opts.recordLog({ wsTaskStop: msg.task_id });
    makeWsFrame(socket, { type: "response", request_id: msg.request_id, code: 0, msg: "ok", data: { stopped: msg.task_id } });
    if (msg.task_id === "__drop_ws__") {
      setImmediate(() => { socket.destroy(); });
    }
  }
}

export function attachKapWsServer(server, opts) {
  const wsClients = new Set();

  server.on("upgrade", (req, socket) => {
    const proto = req.headers["sec-websocket-protocol"] ?? "";
    if (!proto.includes(`kimi-code.bearer.${opts.bearer}`)) { socket.destroy(); return; }
    sendUpgradeResponse(socket, req.headers["sec-websocket-key"] ?? "", opts.bearer);
    wsClients.add(socket);
    let buf = Buffer.alloc(0);
    socket.on("data", (chunk) => {
      buf = Buffer.concat([buf, chunk]);
      const parsed = decodeWsFrames(buf);
      buf = parsed.rest;
      for (const f of parsed.frames) {
        if (f.opcode === 8) {
          socket.write(Buffer.from([0x88, 0x00]));
          socket.end();
          wsClients.delete(socket);
        } else if (f.opcode === 1) {
          handleClientMsg(socket, JSON.parse(f.text), opts);
        }
      }
    });
    socket.on("close", () => { wsClients.delete(socket); });
  });

  return {
    broadcast: (obj) => {
      for (const ws of wsClients) { makeWsFrame(ws, obj); }
    },
    closeAll: () => {
      for (const ws of wsClients) { ws.destroy(); }
      wsClients.clear();
    },
    size: () => wsClients.size,
  };
}
