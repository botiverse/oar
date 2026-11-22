"""Probe the three capabilities advertised by the patched KAP CLI on loopback."""

import argparse
import asyncio
import json
import os
import re
import secrets
import shlex
import sys
import tempfile
import time
from contextlib import AsyncExitStack
from pathlib import Path

from aiohttp import ClientSession, ClientTimeout, web

TOOL = "mcp__slot__observe"
INSTRUCTIONS = [
    "INSTRUCTION_A410",
    "INSTRUCTION_B410",
    "INSTRUCTION_C410",
    "INSTRUCTION_BUSY410",
]
PARENT_KEYS = (
    "steered_from_turn_id",
    "steered_from_turn_number",
    "steered_from_prompt_id",
)


def mcp_reply(msg, generation):
    method = msg.get("method")
    if "id" not in msg:
        return None
    if method == "initialize":
        result = {
            "protocolVersion": msg["params"]["protocolVersion"],
            "capabilities": {"tools": {}},
            "serverInfo": {"name": "wire-fixture", "version": "1"},
        }
    elif method == "tools/list":
        result = {
            "tools": [
                {
                    "name": "observe",
                    "description": "Return the fixture generation",
                    "inputSchema": {"type": "object", "properties": {}},
                }
            ]
        }
    elif method == "tools/call":
        result = {"content": [{"type": "text", "text": "GENERATION_" + generation}]}
    else:
        result = {}
    return {"jsonrpc": "2.0", "id": msg["id"], "result": result}


def stdio_fixture():
    for line in sys.stdin:
        msg = json.loads(line)
        with open(os.environ["FIXTURE_TRACE"], "a") as trace:
            print(
                json.dumps([os.environ["FIXTURE_GENERATION"], msg.get("method")]),
                file=trace,
            )
        result = mcp_reply(msg, os.environ["FIXTURE_GENERATION"])
        if result is not None:
            print(json.dumps(result), flush=True)


async def observe(check, seconds=15):
    deadline = time.monotonic() + seconds
    while time.monotonic() < deadline:
        value = check()
        if value:
            return value
        await asyncio.sleep(0.02)
    raise TimeoutError("fixture observation deadline")


def turn_fields(turn):
    keys = ("turn_id", "turn_number", "kind", "outcome", *PARENT_KEYS)
    return {k: turn[k] for k in keys if k in turn}


class Probe:
    def __init__(self, binary, directory, stream, client):
        self.binary, self.root, self.stream, self.client = (
            binary,
            directory,
            stream,
            client,
        )
        self.delay_list = 0
        self.mcp_calls = []
        self.work, self.state = directory / "project", directory / "home" / "kimi"
        self.work.mkdir()
        self.state.mkdir(parents=True)
        self.frames, self.hits = [], []
        self.canaries = {k: secrets.token_hex(16) for k in ["H1", "H2", "H3", "S1", "S2"]}
        self.proc = self.socket = self.reader = None
        self.stage = "startup"
        self.n = 0
        self.started = time.monotonic()
        self.aliases = {}
        self.turn_aliases = {}

    def log(self, kind, **data):
        self.n += 1
        row = {
            "n": self.n,
            "ms": round((time.monotonic() - self.started) * 1000),
            "stage": self.stage,
            "type": kind,
            **data,
        }
        encoded = json.dumps(row, separators=(",", ":")).replace(str(self.root), "<fixture>")
        for secret in self.canaries.values():
            encoded = encoded.replace(secret, "<fixture-marker>")
        secret = getattr(self, "bearer", None)
        if secret:
            encoded = encoded.replace(secret, "<redacted>")

        def session_name(match):
            return self.aliases.setdefault(match[0], f"session-{len(self.aliases) + 1}")

        encoded = re.sub(r"session_[a-f0-9-]{36}", session_name, encoded)
        encoded = re.sub(
            r"\bt_[a-f0-9]{12}\b",
            lambda m: self.turn_aliases.setdefault(m[0], f"turn-{len(self.turn_aliases) + 1}"),
            encoded,
        )
        self.stream.write(encoded + "\n")
        self.stream.flush()

    async def serve(self, stack):
        app = web.Application()
        app.router.add_post("/v1/chat/completions", self.model)
        app.router.add_post("/mcp", self.mcp)
        runner = web.AppRunner(app, access_log=None)
        await runner.setup()
        stack.push_async_callback(runner.cleanup)
        site = web.TCPSite(runner, "127.0.0.1", 0)
        await site.start()
        self.local = f"http://127.0.0.1:{runner.addresses[0][1]}"
        (self.state / "config.toml").write_text(
            'default_model = "fixture"\nauto_session_title = false\n[loop_control]\nmax_attempts_per_step = 1\n'
            f'[providers.local]\ntype = "openai"\nbase_url = "{self.local}/v1"\napi_key = "fixture"\n'
            '[models.fixture]\nprovider = "local"\nmodel = "fixture"\nmax_context_size = 65536\n'
        )
        # A real Bash tool signals when it has started and waits for the host.
        (self.work / "hold.py").write_text(
            "import pathlib,sys,time\nx=pathlib.Path(sys.argv[1]); x.with_suffix('.started').touch()\n"
            "for i in range(600):\n if x.with_suffix('.release').exists(): break\n time.sleep(.05)\n"
            "print('fixture tool finished')\n"
        )

    async def mcp(self, request):
        msg = await request.json()
        generation = next(
            (
                k
                for k, v in self.canaries.items()
                if v == request.headers.get("X-Fixture-Generation")
            ),
            "NONE",
        )
        if msg.get("method") == "tools/list":
            await asyncio.sleep(self.delay_list)
        if msg.get("method") == "tools/call":
            self.mcp_calls.append(generation)
        reply = mcp_reply(msg, generation)
        self.log("http-mcp", method=msg.get("method"), generation=generation)
        return web.json_response(reply) if reply is not None else web.Response(status=202)

    async def model(self, request):
        body = await request.json()
        messages = body["messages"]
        system = " ".join(json.dumps(m["content"]) for m in messages if m["role"] == "system")
        users = [
            s
            for m in messages
            if m["role"] == "user"
            for s in re.findall(r"\bQ410_[A-Z0-9_]+\b", json.dumps(m["content"]))
        ]
        marker = users[-1] if users else ""
        tool_names = [t["function"]["name"] for t in body.get("tools", [])]
        tool_messages = [m for m in messages if m["role"] == "tool"]
        replies = [m["tool_call_id"] for m in tool_messages]
        id_ = "call_" + marker
        tool = None
        announced = any(
            TOOL in str(m.get("content", "")) and "<tools_added>" in str(m.get("content", ""))
            for m in messages
        )
        if id_ not in replies:
            if marker.startswith("Q410_MCP_") and TOOL in tool_names:
                tool = (TOOL, {})
            elif marker in ("Q410_PARENT", "Q410_FIRST", "Q410_BUSY"):
                tool = (
                    "Bash",
                    {
                        "command": shlex.join([sys.executable, "hold.py", marker]),
                        "description": "Wait for fixture release",
                    },
                )
            elif marker == "Q410_AGENT":
                tool = (
                    "Agent",
                    {
                        "description": "Inspect child fixture",
                        "prompt": "Reply to Q410_CHILD.",
                    },
                )
        current_result = next(
            (str(m["content"]) for m in tool_messages if m["tool_call_id"] == id_), ""
        )
        current_generations = re.findall(r"GENERATION_([A-Z0-9]+)", current_result)
        observed = {
            "marker": marker,
            "systemMarkers": [k for k in INSTRUCTIONS if k in system],
            "hasMcp": TOOL in tool_names,
            "announced": announced,
            "currentGenerations": current_generations,
            "emitted": tool[0] if tool else None,
            "hasCurrentResult": bool(current_result),
            **(
                {"toolError": current_result[:220]}
                if marker.startswith("Q410_MCP_") and current_result and not current_generations
                else {}
            ),
        }
        self.hits.append(observed)
        self.log("provider", **observed)
        delta = {"role": "assistant"}
        if tool:
            delta["tool_calls"] = [
                {
                    "index": 0,
                    "id": id_,
                    "type": "function",
                    "function": {"name": tool[0], "arguments": json.dumps(tool[1])},
                }
            ]
        else:
            delta["content"] = "Fixture response."

        def packet(d, reason=None):
            return (
                "data: "
                + json.dumps(
                    {
                        "id": "fixture",
                        "object": "chat.completion.chunk",
                        "model": "fixture",
                        "choices": [{"index": 0, "delta": d, "finish_reason": reason}],
                    }
                )
                + "\n\n"
            )

        return web.Response(
            text=packet(delta) + packet({}, "tool_calls" if tool else "stop") + "data: [DONE]\n\n",
            content_type="text/event-stream",
        )

    async def boot(self):
        env = {k: os.environ[k] for k in ("PATH", "LANG", "SystemRoot") if k in os.environ}
        env.update({k: str(self.state.parent) for k in ("HOME", "USERPROFILE")})
        env.update(
            {
                k: str(self.state)
                for k in (
                    "KIMI_CODE_HOME",
                    "XDG_CONFIG_HOME",
                    "XDG_DATA_HOME",
                    "XDG_CACHE_HOME",
                )
            }
        )
        env.update(
            {
                "KIMI_DISABLE_TELEMETRY": "1",
                "KIMI_CODE_MODEL_CATALOG_REFRESH_ON_START": "0",
            }
        )
        self.proc = await asyncio.create_subprocess_exec(
            *self.binary,
            "web",
            "--json",
            "--host",
            "127.0.0.1",
            "--port",
            "0",
            cwd=self.work,
            env=env,
            stdout=asyncio.subprocess.PIPE,
            stderr=asyncio.subprocess.DEVNULL,
        )
        ready = json.loads(await asyncio.wait_for(self.proc.stdout.readline(), 30))
        self.origin, self.bearer, self.ws_url = (
            ready["origin"],
            ready["token"],
            ready["ws_url"],
        )
        meta = await self.api("GET", "/meta")
        data = meta["data"]
        required = (
            "session_ephemeral_mcp",
            "session_append_system_prompt",
            "steer_parent_correlation",
        )
        self.log(
            "meta",
            version=data["server_version"],
            capabilities={k: data["capabilities"].get(k) for k in required},
        )
        assert data["server_version"] == "2.7.2-botiverse.0"
        assert all(data["capabilities"].get(k) is True for k in required)
        self.socket = await self.client.ws_connect(
            self.ws_url, protocols=["kimi-code.bearer." + self.bearer]
        )
        self.reader = asyncio.create_task(self.read())

    async def read(self):
        async for msg in self.socket:
            b = msg.json()
            self.frames.append(b)
            t = b["type"]
            if t == "ping":
                await self.socket.send_json({"type": "pong"})
            elif t in ("turn.started", "turn.ended"):
                self.log(
                    "ws",
                    event=t,
                    session=b["session_id"],
                    agent=b["agent_id"],
                    turn=turn_fields(b["turn"]),
                )
            elif t == "turns":
                self.log(
                    "ws-replay",
                    session=b["session_id"],
                    agent=b["agent_id"],
                    turns=[turn_fields(v) for v in b["turns"]],
                )
            elif t == "task" and b.get("child_agent_id"):
                self.log(
                    "child-task",
                    agent=b["agent_id"],
                    child=b["child_agent_id"],
                    parentCall=b["parent_tool_call_id"],
                    status=b["status"],
                )
            elif t == "item.ended" and b["item"].get("kind") == "compaction":
                self.log(
                    "compacted",
                    trigger=b["item"]["trigger"],
                    outcome=b["item"]["outcome"],
                )
            elif t == "item.ended" and b["item"]["type"] == "user_message":
                self.log(
                    "user-item",
                    turn=b["turn_id"],
                    agent=b["agent_id"],
                    promptIds=b["item"].get("prompt_ids", []),
                )

    async def api(self, method, route, body=None):
        kw = {"json": body} if body is not None else {}
        async with self.client.request(
            method,
            self.origin + "/api/v1" + route,
            headers={"Authorization": "Bearer " + self.bearer},
            **kw,
        ) as r:
            res = await r.json()
            data = res.get("data") or {}
            inputs = {}
            if body and "mcp_servers" in body:
                inputs["servers"] = {
                    name: {
                        "transport": cfg["transport"],
                        **(
                            {"environment_id": cfg["environment_id"]}
                            if "environment_id" in cfg
                            else {}
                        ),
                    }
                    for name, cfg in body["mcp_servers"].items()
                }
            if body and "append_system_prompt" in body:
                inputs["append"] = body["append_system_prompt"]
            self.log(
                "rest",
                **inputs,
                method=method,
                route=route,
                http=r.status,
                code=res.get("code"),
                fields=sorted(body) if body is not None else [],
                **({"msg": res.get("msg")} if res.get("code") else {}),
                **({"prompt": data["prompt_id"]} if "prompt_id" in data else {}),
            )
            return res

    async def post(self, route, body=None):
        res = await self.api("POST", route, {} if body is None else body)
        assert res.get("code") == 0, (
            self.stage,
            route,
            res.get("code"),
            res.get("msg"),
        )
        return res["data"]

    async def subscribe(self, sid, agent="main"):
        pos = len(self.frames)
        await self.socket.send_json(
            {
                "type": "subscribe",
                "request_id": f"sub{pos}",
                "session_id": sid,
                "agent_ids": [agent],
            }
        )
        return await observe(
            lambda: next(
                (
                    x
                    for x in self.frames[pos:]
                    if x["type"] == "turns"
                    and x.get("session_id") == sid
                    and x.get("agent_id") == agent
                ),
                None,
            )
        )

    async def create(self, **opts):
        row = await self.post(
            "/sessions",
            {
                "cwd": str(self.work),
                "agent_config": {"permission_mode": "yolo"},
                **opts,
            },
        )
        return row["id"]

    async def prompt(self, sid, marker, *, wait=True):
        start = len(self.hits)
        await self.post(f"/sessions/{sid}/prompts", content(marker))
        if not wait:
            return
        result = await self.post(f"/sessions/{sid}:wait", {"timeout_ms": 15000})
        assert not result["timed_out"] and result["session"]["activity"] == "idle", (
            marker,
            result["session"]["activity"],
        )
        hits = [v for v in self.hits[start:] if v["marker"] == marker]
        assert hits, (self.stage, marker)
        return hits

    async def stop(self):
        if self.socket is not None and not self.socket.closed:
            await self.socket.close()
        if self.reader is not None:
            await self.reader
        if self.proc and self.proc.returncode is None:
            try:
                await self.post("/shutdown")
                await asyncio.wait_for(self.proc.wait(), 10)
            finally:
                if self.proc.returncode is None:
                    self.proc.kill()
                    await self.proc.wait()
        self.log("exit", code=self.proc.returncode)
        self.proc = None

    async def cleanup(self):
        if self.proc is not None:
            try:
                await self.stop()
            finally:
                if self.proc is not None and self.proc.returncode is None:
                    self.proc.kill()
                    await self.proc.wait()

    def servers(self, generation):
        if generation.startswith("H"):
            return {
                "slot": {
                    "transport": "http",
                    "url": self.local + "/mcp",
                    "headers": {"X-Fixture-Generation": self.canaries[generation]},
                }
            }
        return {
            "slot": {
                "transport": "stdio",
                "environment_id": "local",
                "command": sys.executable,
                "args": [str(Path(__file__).resolve()), "--stdio"],
                "env": {
                    "FIXTURE_TRACE": str(self.root / "stdio.jsonl"),
                    "FIXTURE_GENERATION": generation,
                    "FIXTURE_UNUSED_MARKER": self.canaries[generation],
                },
            }
        }

    def disk(self):
        leaks = []
        for path in self.state.rglob("*"):
            if path.is_file():
                data = path.read_bytes()
                if any(v.encode() in data for v in self.canaries.values()):
                    leaks.append(str(path.relative_to(self.state)))
        self.log(
            "state-sample",
            globalConfigExists=(self.state / "mcp.json").exists(),
            fixtureMarkersOnDisk=len(leaks),
        )
        assert not leaks and not (self.state / "mcp.json").exists()


def content(marker):
    return {"prompt_id": marker, "content": [{"type": "text", "text": marker}]}


def stdio_events(p):
    trace = p.root / "stdio.jsonl"
    return [json.loads(l) for l in trace.read_text().splitlines()] if trace.exists() else []


async def check_mcp(p, sid, marker, expected, *, allow_stale=False):
    http_start, stdio_start = len(p.mcp_calls), len(stdio_events(p))
    hits = await p.prompt(sid, "Q410_MCP_" + marker)
    calls = p.mcp_calls[http_start:] + [
        g for g, method in stdio_events(p)[stdio_start:] if method == "tools/call"
    ]
    results = [g for h in hits for g in h["currentGenerations"]]
    p.log(
        "mcp-result",
        prompt=marker,
        advertised=any(h["hasMcp"] for h in hits),
        reached=calls,
        returned=results,
        toolErrors=[h["toolError"] for h in hits if "toolError" in h],
    )
    assert calls == results == ([expected] if expected else []), (
        marker,
        calls,
        results,
    )
    if expected or not allow_stale:
        assert any(h["hasMcp"] for h in hits) == bool(expected)
    return hits


async def mcp(p):
    p.stage = "create-and-isolate"
    a = await p.create(mcp_servers=p.servers("H1"), append_system_prompt=INSTRUCTIONS[0])
    b = await p.create(mcp_servers=p.servers("H3"))
    peer = await p.create()
    assert all(
        h["systemMarkers"] == [INSTRUCTIONS[0]] for h in await check_mcp(p, a, "FIRST_HTTP", "H1")
    )
    await check_mcp(p, b, "SAME_NAME_PEER", "H3")
    await check_mcp(p, peer, "EMPTY_PEER", None)
    p.disk()
    p.stage = "warm-rotation"
    await p.post(f"/sessions/{a}:resume", {"mcp_servers": p.servers("H2")})
    assert all(
        h["systemMarkers"] == [INSTRUCTIONS[0]] for h in await check_mcp(p, a, "ROTATE_HTTP", "H2")
    )
    await p.post(f"/sessions/{b}:resume", {"mcp_servers": p.servers("S1")})
    await check_mcp(p, b, "ROTATE_STDIO", "S1")
    await p.post(f"/sessions/{b}:resume", {"mcp_servers": p.servers("S2")})
    await check_mcp(p, b, "REPLACE_STDIO", "S2")
    await p.post(f"/sessions/{a}:resume", {})
    await check_mcp(p, a, "OMIT_WARM", "H2")
    p.stage = "active-refusal"
    await p.prompt(a, "Q410_BUSY", wait=False)
    await observe((p.work / "Q410_BUSY.started").exists)
    for fields in (
        {"mcp_servers": p.servers("H3")},
        {"mcp_servers": p.servers("H3"), "append_system_prompt": INSTRUCTIONS[3]},
    ):
        refused = await p.api("POST", f"/sessions/{a}:resume", fields)
        assert refused["code"] == 40901
    (p.work / "Q410_BUSY.release").touch()
    await p.post(f"/sessions/{a}:wait", {"timeout_ms": 15000})
    assert all(
        h["systemMarkers"] == [INSTRUCTIONS[0]] for h in await check_mcp(p, a, "AFTER_BUSY", "H2")
    )
    p.disk()
    p.stage = "cold-resume"
    await p.stop()
    p.disk()
    await p.boot()
    await p.post(f"/sessions/{a}:resume", {})
    await check_mcp(p, a, "OMIT_COLD", None, allow_stale=True)
    await p.post(
        f"/sessions/{b}:resume",
        {"mcp_servers": p.servers("S1"), "append_system_prompt": INSTRUCTIONS[1]},
    )
    assert all(
        h["systemMarkers"] == [INSTRUCTIONS[1]]
        for h in await check_mcp(p, b, "COLD_REPLACEMENT", "S1")
    )
    await p.post(f"/sessions/{b}:resume", {"mcp_servers": {}, "append_system_prompt": ""})
    assert all(
        h["systemMarkers"] == []
        for h in await check_mcp(p, b, "EXPLICIT_EMPTY", None, allow_stale=True)
    )
    p.disk()


async def discovery(p):
    # Compare the server's actual handshake, persisted discovery and model-visible schema.
    for transport, bound, delay in [
        ("stdio", False, 0),
        ("stdio", True, 0),
        ("http", True, 0),
        ("http", True, 0.5),
    ]:
        p.stage = (
            ("stdio-bound" if bound else "stdio-unbound")
            if transport == "stdio"
            else ("http-delayed" if delay else "http-immediate")
        )
        generation = "S1" if transport == "stdio" else "H1"
        servers = p.servers(generation)
        if not bound:
            del servers["slot"]["environment_id"]
        p.delay_list = delay
        before = len(stdio_events(p))
        sid = await p.create(mcp_servers=servers)
        hits = await p.prompt(sid, "Q410_MCP_" + p.stage.upper().replace("-", "_"))
        methods = [method for _, method in stdio_events(p)[before:]]
        wires = list((p.state / "sessions").glob("*/" + sid + "/agents/main/wire.jsonl"))
        assert len(wires) == 1
        rows = [json.loads(line) for line in wires[0].read_text().splitlines()]
        discovered = any(
            r["type"] == "mcp.tools_discovered"
            and r.get("serverName") == "slot"
            and "observe" in r.get("enabledNames", [])
            for r in rows
        )
        visible = any(h["hasMcp"] for h in hits)
        returned = [g for h in hits for g in h["currentGenerations"]]
        p.log(
            "discovery",
            transport=transport,
            serverEnvironment="local" if transport == "stdio" and bound else None,
            listDelayMs=int(delay * 1000),
            stdioMethods=methods,
            registered=discovered,
            advertised=visible,
            generations=returned,
        )
        assert discovered == bound and returned == ([generation] if visible else [])
        if transport == "stdio":
            assert ("tools/list" in methods) == bound
        if not bound:
            assert not visible
        if delay:
            result = await p.prompt(sid, "Q410_MCP_AFTER_DISCOVERY")
            p.log(
                "second-prompt",
                advertised=any(h["hasMcp"] for h in result),
                generations=[g for h in result for g in h["currentGenerations"]],
            )


async def reserved(p):
    p.stage = "reserved-names"
    sid = await p.create()
    config = p.servers("H1")["slot"]
    for name in ("__proto__", "constructor", "prototype", " "):
        for route, base in [
            ("/sessions", {"cwd": str(p.work)}),
            (f"/sessions/{sid}:resume", {}),
        ]:
            res = await p.api("POST", route, {**base, "mcp_servers": {name: config}})
            p.log(
                "name-validation",
                operation="create" if base else "resume",
                name=name,
                code=res["code"],
            )
            assert res["code"] == 40001
    await check_mcp(p, sid, "AFTER_VALIDATION", None)


async def check_system(p, sid, marker, expected):
    hits = await p.prompt(sid, marker)
    assert all(h["systemMarkers"] == expected for h in hits), (
        marker,
        [h["systemMarkers"] for h in hits],
    )


async def instructions(p):
    a, b, c, busy = INSTRUCTIONS
    p.stage = "create"
    sid = await p.create(append_system_prompt=a)
    peer = await p.create()
    await check_system(p, sid, "Q410_CREATED", [a])
    await check_system(p, peer, "Q410_OTHER", [])
    await p.stop()
    p.stage = "omitted-cold"
    await p.boot()
    await p.post(f"/sessions/{sid}:resume", {})
    await check_system(p, sid, "Q410_PRESERVED", [a])
    await p.stop()
    p.stage = "replace-cold"
    await p.boot()
    await p.post(f"/sessions/{sid}:resume", {"append_system_prompt": b})
    await check_system(p, sid, "Q410_UPDATED", [b])
    p.stage = "replace-live"
    await p.post(f"/sessions/{sid}:resume", {"append_system_prompt": c})
    await check_system(p, sid, "Q410_LIVE", [c])
    await p.prompt(sid, "Q410_BUSY", wait=False)
    await observe((p.work / "Q410_BUSY.started").exists)
    res = await p.api("POST", f"/sessions/{sid}:resume", {"append_system_prompt": busy})
    assert res["code"] == 40901
    (p.work / "Q410_BUSY.release").touch()
    await p.post(f"/sessions/{sid}:wait", {"timeout_ms": 15000})
    p.stage = "compact"
    await p.subscribe(sid)
    i = len(p.frames)
    await p.post(f"/sessions/{sid}:compact", {"instruction": "Summarize this fixture briefly."})
    await observe(
        lambda: any(
            f["type"] == "item.ended"
            and f.get("item", {}).get("kind") == "compaction"
            and f["item"].get("outcome") == "completed"
            and f["session_id"] == sid
            for f in p.frames[i:]
        )
    )
    await observe(
        lambda: any(
            f["type"] == "agent" and f["session_id"] == sid and f.get("compacting") is False
            for f in p.frames[i:]
        )
    )
    await check_system(p, sid, "Q410_AFTER_COMPACT", [c])
    p.stage = "child-exclusion"
    i = len(p.hits)
    await check_system(p, sid, "Q410_AGENT", [c])
    children = [h for h in p.hits[i:] if h["marker"] == "Q410_CHILD"]
    assert children and all(h["systemMarkers"] == [] for h in children)
    p.stage = "clear"
    await p.post(f"/sessions/{sid}:resume", {"append_system_prompt": ""})
    await check_system(p, sid, "Q410_CLEARED", [])
    await p.stop()
    await p.boot()
    await p.post(f"/sessions/{sid}:resume", {})
    await check_system(p, sid, "Q410_CLEARED_COLD", [])


async def steer(p):
    p.stage = "two-steers"
    sid = await p.create()
    await p.subscribe(sid)
    await p.prompt(sid, "Q410_PARENT", wait=False)
    for parent, child in [("Q410_PARENT", "Q410_FIRST"), ("Q410_FIRST", "Q410_SECOND")]:
        await observe((p.work / (parent + ".started")).exists)
        task = asyncio.create_task(p.post(f"/sessions/{sid}/steer", content(child)))
        # Keep the tool running long enough for the loopback request to reach KAP.
        await asyncio.sleep(0.25)
        (p.work / (parent + ".release")).touch()
        await task
    await p.post(f"/sessions/{sid}:wait", {"timeout_ms": 15000})
    await p.prompt(sid, "Q410_ORDINARY")
    await observe(
        lambda: (
            len([x for x in p.frames if x["type"] == "turn.ended" and x["session_id"] == sid]) == 4
        )
    )
    assert [h["marker"] for h in p.hits if h["emitted"] == "Bash"] == [
        "Q410_PARENT",
        "Q410_FIRST",
    ]
    ends = [
        turn_fields(x["turn"])
        for x in p.frames
        if x["type"] == "turn.ended" and x["session_id"] == sid
    ]
    starts = [
        turn_fields(x["turn"])
        for x in p.frames
        if x["type"] == "turn.started" and x["session_id"] == sid
    ]
    assert all(t["outcome"] == "completed" for t in ends)

    def shape(rows):
        return [{k: r.get(k) for k in ("turn_id", "turn_number", *PARENT_KEYS)} for r in rows]

    def valid_chain(turns):
        if [t.get("turn_number") for t in turns] != [0, 1, 2, 3]:
            return False
        for index, parent_prompt in [(1, "Q410_PARENT"), (2, "Q410_FIRST")]:
            if [turns[index].get(k) for k in PARENT_KEYS] != [
                turns[index - 1]["turn_id"],
                index - 1,
                parent_prompt,
            ]:
                return False
        return all(k not in turns[i] for i in (0, 3) for k in PARENT_KEYS)

    p.stage = "cold-replay"
    await p.stop()
    await p.boot()
    await p.post(f"/sessions/{sid}:resume", {})
    hist = await p.api("GET", f"/sessions/{sid}/agents/main/turns")
    history = [turn_fields(t) for t in hist["data"]["turns"]]
    p.log("rest-replay", turns=history)
    snapshot = await p.subscribe(sid)
    replay = [turn_fields(t) for t in snapshot["turns"]]
    checks = {
        "started": valid_chain(starts),
        "ended": valid_chain(ends),
        "history": valid_chain(history),
        "coldSocket": valid_chain(replay),
        "sameIdsAndParents": shape(starts) == shape(ends) == shape(history) == shape(replay),
    }
    p.log("correlation", **checks)
    assert all(checks.values()), checks


async def run(scenario, binary, out):
    async with AsyncExitStack() as stack:
        temp = stack.enter_context(tempfile.TemporaryDirectory(prefix="kimi-kap-patched-"))
        client = await stack.enter_async_context(ClientSession(timeout=ClientTimeout(total=35)))
        p = Probe(binary, Path(temp), out, client)
        await p.serve(stack)
        stack.push_async_callback(p.cleanup)
        try:
            await p.boot()
            await {
                "mcp": mcp,
                "discovery": discovery,
                "reserved": reserved,
                "instructions": instructions,
                "steer": steer,
            }[scenario](p)
            await p.stop()
            if scenario in ("mcp", "discovery"):
                p.disk()
            p.log("complete", scenario=scenario)
        except Exception as e:
            p.log("failure", error=type(e).__name__, message=str(e))
            raise


if __name__ == "__main__":
    if sys.argv[1:] == ["--stdio"]:
        stdio_fixture()
    else:
        parser = argparse.ArgumentParser(description=__doc__)
        parser.add_argument(
            "scenario",
            choices=["mcp", "discovery", "reserved", "instructions", "steer"],
        )
        parser.add_argument("output", type=Path)
        parser.add_argument(
            "executable",
            nargs="+",
            help="absolute CLI path, or node and absolute built main.mjs",
        )
        args = parser.parse_args()
        with args.output.open("x") as stream:
            asyncio.run(run(args.scenario, args.executable, stream))
