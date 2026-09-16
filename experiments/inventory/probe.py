#!/usr/bin/env python3
"""Native skills/MCP/tools survey. Stdlib only; Pi helper uses the installed SDK.
Run from repo root: python3 experiments/inventory/probe.py [all|codex|claude|grok|kimi|pi] [workspace]
No prompts, tools/call, auth flows, configuration writes or approvals are sent.
The Kimi web probe creates and deletes its own empty session; see README.md.
Outputs sanitized field/count summaries, never raw configs, credentials or history.
"""
import asyncio
import collections
import contextlib
import json
import os
from pathlib import Path
import sys

CWD = str(Path(sys.argv[2] if len(sys.argv) > 2 else os.getcwd()).resolve())


def emit(runtime, surface, **data):
    print(json.dumps({'runtime': runtime, 'surface': surface, **data}, ensure_ascii=False), flush=True)


def rows(value):
    return [v for v in value if isinstance(v, dict)] if isinstance(value, list) else []


def inventory(value):
    if not isinstance(value, list):
        return {'type': type(value).__name__}
    entries = rows(value)
    result = {'count': len(value), 'fields': sorted({k for row in entries for k in row})}
    for field in ('enabled', 'active', 'status', 'runtimeStatus', 'authStatus', 'source', 'scope', 'isLoaded'):
        # Only approved enum values; do not print arbitrary source paths or error text.
        allowed = {True, False, None, 'connected', 'connecting', 'pending', 'disabled', 'disconnected', 'failed', 'error', 'needs-auth', 'builtin', 'mcp', 'user', 'project', 'system', 'admin', 'plugin', 'skill', 'unsupported', 'notLoggedIn', 'bearerToken', 'oAuth'}
        values = [row[field] for row in entries if field in row and isinstance(row[field], (str, bool, type(None))) and row[field] in allowed]
        if values:
            result[field] = dict(collections.Counter(str(v) for v in values))
    for field in ('parameters', 'inputSchema', 'input_schema', 'description'):
        if any(field in row for row in entries):
            result[field + 'Present'] = sum(row.get(field) is not None for row in entries)
    return result


def fields(value):
    return sorted(value) if isinstance(value, dict) else []


async def stop(process):
    if process.returncode is None:
        process.terminate()
        try:
            await asyncio.wait_for(process.wait(), 3)
        except asyncio.TimeoutError:
            process.kill()
            await process.wait()


async def command(args, timeout=30):
    proc = await asyncio.create_subprocess_exec(*args, cwd=CWD, stdout=asyncio.subprocess.PIPE, stderr=asyncio.subprocess.DEVNULL, limit=8_000_000)
    try:
        stdout, _ = await asyncio.wait_for(proc.communicate(), timeout)
        if proc.returncode:
            raise RuntimeError('command failed (output omitted)')
        return stdout.decode()
    finally:
        await stop(proc)


class Wire:
    def __init__(self, runtime, args):
        self.runtime, self.args = runtime, args
        self.sequence = 0
        self.notifications = []

    async def __aenter__(self):
        env = dict(os.environ)
        env.pop('CLAUDECODE', None)
        self.process = await asyncio.create_subprocess_exec(*self.args, cwd=CWD, env=env,
            stdin=asyncio.subprocess.PIPE, stdout=asyncio.subprocess.PIPE, stderr=asyncio.subprocess.DEVNULL, limit=8_000_000)
        return self

    async def __aexit__(self, *args):
        await stop(self.process)

    async def send(self, message):
        self.process.stdin.write((json.dumps(message) + '\n').encode())
        await self.process.stdin.drain()

    async def request(self, method, params=None):
        self.sequence += 1
        request_id = str(self.sequence)
        message = {'jsonrpc': '2.0', 'id': request_id, 'method': method, 'params': params or {}}
        if self.runtime == 'claude':
            message = {'type': 'control_request', 'request_id': request_id, 'request': {'subtype': method, **(params or {})}}
        await self.send(message)

        async def read():
            while True:
                line = await self.process.stdout.readline()
                if not line:
                    raise RuntimeError('protocol process exited')
                try:
                    reply = json.loads(line)
                except ValueError:
                    continue
                if self.runtime == 'claude':
                    inner = reply.get('response', {})
                    if reply.get('type') == 'control_response' and inner.get('request_id') == request_id:
                        if inner.get('subtype') == 'success':
                            return inner.get('response', {})
                        emit(self.runtime, method, outcome='rejected', errorClass='unsupported' if any(word in str(inner.get('error', '')).lower() for word in ('not support', 'unsupported')) else 'native_error')
                        return None
                elif reply.get('id') == request_id:
                    if 'error' in reply:
                        emit(self.runtime, method, outcome='rejected', errorCode=reply['error'].get('code'))
                        return None
                    return reply.get('result', {})
                else:
                    self.notifications.append(reply)
                if self.runtime == 'claude':
                    self.notifications.append(reply)
                if self.runtime != 'claude' and 'id' in reply and 'method' in reply:
                    await self.send({'jsonrpc': '2.0', 'id': reply['id'], 'error': {'code': -32601, 'message': 'Read-only inventory probe'}})
        return await asyncio.wait_for(read(), 30)


async def codex():
    binary = os.environ.get('OAR_CODEX_BIN', 'codex')
    emit('codex', 'version', version=(await command([binary, '--version'])).strip())
    async with Wire('codex', [binary, 'app-server', '--listen', 'stdio://']) as wire:
        await wire.request('initialize', {'clientInfo': {'name': 'oar_inventory', 'version': '0.0.0'}, 'capabilities': {'experimentalApi': True}})
        await wire.send({'method': 'initialized', 'params': {}})
        result = await wire.request('skills/list', {'cwds': [CWD]})
        for item in result.get('data', []):
            emit('codex', 'skills/list', skills=inventory(item.get('skills')), errors=len(item.get('errors', [])))
        servers, cursor, pages, cursors = [], None, 0, set()
        while True:
            result = await wire.request('mcpServerStatus/list', {'limit': 2, 'detail': 'full', 'cursor': cursor})
            if result is None:
                break
            servers.extend(result.get('data', [])); pages += 1
            cursor = result.get('nextCursor')
            if cursor is None:
                break
            if cursor in cursors or pages >= 100:
                raise RuntimeError('MCP pagination did not finish')
            cursors.add(cursor)
        toolrows = [tool for server in servers for tool in server.get('tools', {}).values()]
        emit('codex', 'mcpServerStatus/list', scope='fresh app-server; no thread', pages=pages,
             servers=inventory(servers), tools=inventory(toolrows), toolErrors=sum(s.get('toolsError') is not None for s in servers))
        # Negative probes are limited evidence, not proof that no other API exists.
        await wire.request('tools/list')


async def claude():
    binary = os.environ.get('OAR_CLAUDE_BIN', 'claude')
    emit('claude', 'version', version=(await command([binary, '--version'])).strip())
    async with Wire('claude', [binary, '-p', '--input-format', 'stream-json', '--output-format', 'stream-json', '--verbose', '--no-session-persistence']) as wire:
        result = await wire.request('initialize')
        emit('claude', 'initialize', responseFields=fields(result), commands=inventory(result.get('commands')), agents=inventory(result.get('agents')))
        result = await wire.request('mcp_status')
        servers = result.get('mcpServers', [])
        initial = inventory(servers)
        for attempt in range(15):
            if not any(s.get('status') == 'pending' for s in servers):
                break
            await asyncio.sleep(1)
            result = await wire.request('mcp_status')
            servers = result.get('mcpServers', [])
        emit('claude', 'mcp_status', initialServers=initial, servers=inventory(servers), tools=inventory([t for s in servers for t in s.get('tools', [])]),
             perServerTools=[{'status':s.get('status'), 'tools':inventory(s.get('tools'))} for s in servers])
        result = await wire.request('get_context_usage', {'detail': 'summary'})
        emit('claude', 'get_context_usage', responseFields=fields(result), skills=inventory(result.get('skills', {}).get('skillFrontmatter')),
             skillCounters={k:v for k,v in result.get('skills', {}).items() if isinstance(v, (int, float))}, mcpTools=inventory(result.get('mcpTools')),
             categories=inventory(result.get('categories')))
        for method in ('list_tools', 'list_skills'):
            await wire.request(method)
        init_events = [v for v in wire.notifications if v.get('type') == 'system' and v.get('subtype') == 'init']
        emit('claude', 'system/init before prompt', count=len(init_events), toolArrays=[inventory(v.get('tools')) for v in init_events])


async def grok():
    binary = os.environ.get('OAR_GROK_BIN', 'grok')
    emit('grok', 'version', version=(await command([binary, '--version'])).strip())
    result = json.loads(await command([binary, 'inspect', '--json']))
    emit('grok', 'inspect --json', skills=inventory(result.get('skills')), mcpServers=inventory(result.get('mcpServers')), responseFields=fields(result))
    result = json.loads(await command([binary, 'mcp', 'list', '--json']))
    emit('grok', 'mcp list --json', responseFields=fields(result), servers=inventory(result if isinstance(result, list) else result.get('servers')))
    async with Wire('grok', [binary, 'agent', '--no-leader', 'stdio']) as wire:
        result = await wire.request('initialize', {'protocolVersion': 1, 'clientCapabilities': {},
            'clientInfo': {'name': 'oar_inventory', 'version': '0.0.0'},
            '_meta': {'clientIdentifier': 'oar', 'clientType': 'generic', 'startupHints': {'nonInteractive': True, 'skipGitStatus': True, 'skipProjectLayout': True}}})
        emit('grok', 'initialize', responseFields=fields(result))
        result = await wire.request('_x.ai/skills/list', {'cwd': CWD})
        if isinstance(result, dict):
            result = result.get('result', result)
            emit('grok', '_x.ai/skills/list', responseFields=fields(result), skills=inventory(result.get('skills')))
        result = await wire.request('_x.ai/mcp/list')
        if isinstance(result, dict):
            result = result.get('result', result)
            servers = result.get('servers', [])
            emit('grok', '_x.ai/mcp/list', servers=inventory(servers), tools=inventory([t for s in servers for t in s.get('tools', [])]),
                 toolContainerTypes=sorted({type(s.get('tools')).__name__ for s in servers}))
        for method in ('tools/list', '_x.ai/tools/list'):
            await wire.request(method)
        # A fresh owned session is required for session-state MCP discovery.
        # Cached auth uses the CLI's credentials; never launches a login flow.
        auth = await wire.request('authenticate', {'methodId': 'cached_token'})
        if auth is not None:
            created = await wire.request('session/new', {'cwd': CWD, 'mcpServers': []})
            if created is not None and isinstance(created.get('sessionId'), str):
                sid = created['sessionId']
                try:
                    emit('grok', 'session/new (owned empty probe)', responseFields=fields(created), metaFields=fields(created.get('_meta')))
                    for attempt in range(10):
                        result = await wire.request('_x.ai/mcp/list', {'sessionId': sid})
                        if result is None:
                            break
                        result = result.get('result', result)
                        servers = result.get('servers', [])
                        if attempt >= 5 and not any(s.get('session', {}).get('status') in ('pending', 'connecting') for s in servers):
                            break
                        await asyncio.sleep(1)
                    emit('grok', '_x.ai/mcp/list (sessionId)', responseFields=fields(result), servers=inventory(servers),
                         perServer=[{'fields':fields(server), 'tools':inventory(server.get('tools')), 'sessionFields':fields(server.get('session')), 'sessionStatus':inventory([server.get('session', {})]), 'sessionTools':inventory(server.get('session', {}).get('tools')), 'sessionStatusFields':fields(server.get('session', {}).get('status'))} for server in servers])
                    for notification in wire.notifications:
                        if 'mcp' in str(notification.get('method','')).lower():
                            emit('grok', 'native MCP notification', method=notification.get('method'), paramsFields=fields(notification.get('params')), servers=inventory(notification.get('params', {}).get('mcpServers')), tools=inventory(notification.get('params', {}).get('tools')), status=inventory([notification.get('params', {})]))
                finally:
                    await wire.request('session/close', {'sessionId': sid})
                    deleted = await wire.request('_x.ai/session/delete', {'sessionId': sid})
                    emit('grok', 'cleanup owned probe session', responseFields=fields(deleted), acknowledged=isinstance(deleted, dict) and deleted.get('success') is True)


async def pi():
    text = await command(['node', str(Path(__file__).with_name('pi.mjs')), CWD], timeout=45)
    # Extensions can log to stdout. Only forward the helper's explicit JSON row.
    for line in text.splitlines():
        with contextlib.suppress(ValueError):
            result = json.loads(line)
            if isinstance(result, dict) and result.get('runtime') == 'pi':
                print(json.dumps(result), flush=True)


async def kimi():
    from kimi_web import probe
    await probe()


async def main():
    selected = sys.argv[1] if len(sys.argv) > 1 else 'all'
    runners = {'codex': codex, 'claude': claude, 'grok': grok, 'kimi': kimi, 'pi': pi}
    if selected not in (*runners, 'all'):
        raise SystemExit('Unknown runtime')
    failures = 0
    for name, run in runners.items():
        if selected in ('all', name):
            try:
                await run()
            except Exception as error:
                emit(name, 'probe', outcome='failed', errorClass=type(error).__name__)
                failures += 1
    if failures:
        raise SystemExit(1)


if __name__ == '__main__':
    asyncio.run(main())
