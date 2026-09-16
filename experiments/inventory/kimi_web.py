"""Exercise Kimi's native loopback Web API; keep its startup token in memory."""
import asyncio
import json
import os
import re
import urllib.error
import urllib.parse
import urllib.request
from probe import CWD, Wire, command, emit, fields, inventory, stop


async def probe():
    binary = os.environ.get('OAR_KIMI_BIN', 'kimi')
    emit('kimi', 'version', version=(await command([binary, '--version'])).strip())
    async with Wire('kimi', [binary, 'acp']) as wire:
        result = await wire.request('initialize', {'protocolVersion': 1, 'clientCapabilities': {}, 'clientInfo': {'name': 'oar_inventory', 'version': '0.0.0'}})
        emit('kimi', 'ACP initialize', capabilities=result.get('agentCapabilities', {}))
        for method in ('skills/list', 'tools/list', 'mcp/list'):
            await wire.request(method)
    proc = await asyncio.create_subprocess_exec(binary, 'web', '--no-open', '--host', '127.0.0.1', '--port', '0',
        cwd=CWD, stdout=asyncio.subprocess.PIPE, stderr=asyncio.subprocess.DEVNULL, limit=8_000_000)
    session_id = None
    try:
        async def ready():
            while True:
                line = await proc.stdout.readline()
                if not line:
                    raise RuntimeError('Kimi web exited before ready')
                match = re.search(r'http://127\.0\.0\.1:\d+/?#token=([^\s\x1b]+)', line.decode(errors='replace'))
                if match:
                    url = urllib.parse.urlsplit(match.group())
                    return f'{url.scheme}://{url.netloc}', urllib.parse.parse_qs(url.fragment)['token'][0]
        origin, token = await asyncio.wait_for(ready(), 30)
        # Continue draining stdout so startup logs cannot block the server.
        drain = asyncio.create_task(proc.stdout.read())

        async def api(path, method='GET', body=None):
            def request():
                req = urllib.request.Request(origin + path, method=method,
                    headers={'Authorization': 'Bearer ' + token, 'Content-Type': 'application/json'},
                    data=json.dumps(body).encode() if body is not None else None)
                try:
                    with urllib.request.urlopen(req, timeout=25) as response:
                        return response.status, json.load(response)
                except urllib.error.HTTPError as error:
                    return error.code, json.load(error)
            status, result = await asyncio.to_thread(request)
            if status >= 400 or result.get('ok') is False or 'error' in result:
                emit('kimi', re.sub(r'/sessions/[^/?]+', '/sessions/{own-probe-id}', path), outcome='error', httpStatus=status,
                     errorCode=(result.get('error') or {}).get('code'))
                raise RuntimeError('native HTTP query failed')
            return result.get('data', result)

        qcwd = urllib.parse.quote(CWD, safe='')
        servers = await api('/api/v2/mcp/servers?cwd=' + qcwd)
        emit('kimi', 'GET /api/v2/mcp/servers', servers=inventory(servers))
        auth = await api('/api/v2/mcp/auth-statuses?verify=false&cwd=' + qcwd)
        emit('kimi', 'GET /api/v2/mcp/auth-statuses?verify=false', servers=inventory(auth))
        created = await api('/api/v1/sessions', 'POST', {'title': 'oar inventory probe (empty)', 'metadata': {'cwd': CWD}})
        session_id = created['id']
        emit('kimi', 'POST /api/v1/sessions', outcome='created own empty probe session', fields=fields(created))
        skills = await api(f'/api/v1/sessions/{session_id}/skills')
        emit('kimi', 'GET /api/v1/sessions/{own-probe-id}/skills', skills=inventory(skills.get('skills')))
        tools = await api('/api/v1/tools?session_id=' + urllib.parse.quote(session_id, safe=''))
        emit('kimi', 'GET /api/v1/tools?session_id={own-probe-id}', tools=inventory(tools.get('tools')))
        live = await api('/api/v1/mcp/servers')
        emit('kimi', 'GET /api/v1/mcp/servers', scope='native most-recent session selection, not a session-id parameter', servers=inventory(live.get('servers')))
        if created.get('workspace_id'):
            skills = await api('/api/v1/workspaces/' + urllib.parse.quote(created['workspace_id'], safe='') + '/skills')
            emit('kimi', 'GET /api/v1/workspaces/{workspace-id}/skills', skills=inventory(skills.get('skills')))
    finally:
        if session_id is not None:
            try:
                result = await api(f'/api/v1/sessions/{session_id}:delete', 'POST', {})
                emit('kimi', 'cleanup own probe session', responseFields=fields(result), deleted=result.get('deleted'))
            except Exception as error:
                emit('kimi', 'cleanup own probe session', outcome='failed', errorClass=type(error).__name__)
                raise
            finally:
                await stop(proc)
        else:
            await stop(proc)
        if 'drain' in locals():
            await drain
