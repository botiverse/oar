"""Kimi workspace skills: isolated native query, no session or model prompt.
Usage: python3 experiments/inventory/kimi-skills.py /absolute/kimi /output/report.json
Startup bearer tokens stay in memory; only skill metadata and file names are saved.
"""
import asyncio
import json
import os
from pathlib import Path
import re
import signal
import sys
import tempfile
import time
import urllib.request


async def stop(process):
    if process.returncode is None:
        os.killpg(process.pid, signal.SIGTERM)
        try:
            await asyncio.wait_for(process.wait(), 3)
        except asyncio.TimeoutError:
            os.killpg(process.pid, signal.SIGKILL)
            await process.wait()


def snapshot(root):
    return sorted(str(p.relative_to(root)) for p in root.rglob('*') if p.is_file())


def fixture(root, name):
    path = root / name / 'SKILL.md'
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(f'---\nname: {name}\ndescription: Isolated native discovery fixture\ndisableModelInvocation: true\n---\nReply only when explicitly requested.\n')


async def sample(binary, root, product):
    home = root / 'home'
    data = root / 'data'
    project = root / 'project'
    for path in (home, data, project / '.git'):
        path.mkdir(parents=True)
    fixture(data / 'skills', 'user-fixture')
    fixture(home / '.agents/skills', 'shared-fixture')
    fixture(project / '.agents/skills', 'project-fixture')
    broken = project / '.agents/skills/broken/SKILL.md'
    broken.parent.mkdir(parents=True)
    broken.write_text('---\nname: [not valid\n---\nMalformed fixture.\n')
    config = data / 'config.toml'
    config.write_text('builtin_product_skills = ' + str(product).lower() + '\n')
    initial_config = config.read_bytes()
    before = snapshot(root)
    env = {'PATH': os.environ['PATH'], 'HOME': str(home), 'KIMI_CODE_HOME': str(data), 'NO_COLOR': '1', 'TERM': 'dumb'}
    version = await asyncio.create_subprocess_exec(binary, '--version', env=env, stdout=asyncio.subprocess.PIPE, stderr=asyncio.subprocess.DEVNULL)
    version_text = (await version.communicate())[0].decode().strip()
    started = time.monotonic()
    process = await asyncio.create_subprocess_exec(binary, 'web', '--no-open', '--host', '127.0.0.1', '--port', '0', cwd=project, env=env, stdout=asyncio.subprocess.PIPE, stderr=asyncio.subprocess.DEVNULL, start_new_session=True)
    created = None
    try:
        async def ready():
            while line := await process.stdout.readline():
                match = re.search(r'http://127\.0\.0\.1:(\d+)/?#token=([^\s\x1b]+)', line.decode(errors='replace'))
                if match:
                    return 'http://127.0.0.1:' + match[1], match[2]
            raise RuntimeError('Kimi exited before ready (native output omitted)')
        origin, token = await asyncio.wait_for(ready(), 30)
        startup_ms = round((time.monotonic() - started) * 1000)
        drain = asyncio.create_task(process.stdout.read())

        async def api(path, method='GET', body=None):
            def request():
                req = urllib.request.Request(origin + '/api/v1' + path, method=method, headers={'Authorization': 'Bearer ' + token, **({'Content-Type': 'application/json'} if body is not None else {})}, data=json.dumps(body).encode() if body is not None else None)
                with urllib.request.urlopen(req, timeout=10) as response:
                    result = json.load(response)
                if result.get('code') != 0 or not isinstance(result.get('data'), dict):
                    raise RuntimeError('Kimi query failed (native payload omitted)')
                return result['data']
            return await asyncio.to_thread(request)

        workspaces = await api('/workspaces')
        sessions_before = await api('/sessions')
        workspace = await api('/workspaces', 'POST', {'root': str(project), 'name': 'oar-skill-discovery'})
        created = workspace['id']
        result = await api('/workspaces/' + created + '/skills')
        sessions_after = await api('/sessions')
        await api('/workspaces/' + created, 'DELETE')
        created = None
        elapsed_ms = round((time.monotonic() - started) * 1000)
        report = {'version': version_text, 'builtinProductSkills': product, 'startupMs': startup_ms, 'totalReadMs': elapsed_ms, 'loopbackPort': True, 'sessionsBefore': sessions_before, 'sessionsAfter': sessions_after, 'workspacesBefore': workspaces, 'skills': result, 'configUnchanged': config.read_bytes() == initial_config}
    finally:
        try:
            if created is not None:
                await api('/workspaces/' + created, 'DELETE')
        finally:
            await stop(process)
            if 'drain' in locals():
                await drain
    report['newFiles'] = sorted(set(snapshot(root)) - set(before))
    report['processExited'] = process.returncode is not None
    # Only remove disposable directory prefixes, never expose token-bearing files.
    return json.loads(json.dumps(report).replace(str(root), '<fixture>'))


async def main():
    binary, destination = str(Path(sys.argv[1]).resolve()), Path(sys.argv[2])
    with tempfile.TemporaryDirectory(prefix='oar-kimi-skills-') as folder:
        root = Path(folder)
        observations = [await sample(binary, root / str(product), product) for product in (True, False)]
    destination.write_text(json.dumps(observations, indent=2) + '\n')
    print(json.dumps([{'version': r['version'], 'product': r['builtinProductSkills'], 'startupMs': r['startupMs'], 'names': [s['name'] for s in r['skills']['skills']], 'newFiles': r['newFiles'], 'configUnchanged': r['configUnchanged']} for r in observations], indent=2))


asyncio.run(main())
