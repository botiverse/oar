"""Linux query-only control. No login or prompt; native startup may use the network."""
import argparse
import json
import os
from pathlib import Path
import selectors
import signal
import subprocess
import tempfile
import time

parser = argparse.ArgumentParser()
parser.add_argument('command', type=Path)
parser.add_argument('output', type=Path)
parser.add_argument('--trace', action='store_true', help='Trace connect syscalls with strace')
args = parser.parse_args()
output = args.output.resolve()
output.mkdir(parents=True, exist_ok=True)
home = Path(tempfile.mkdtemp(prefix='home-', dir=output))
cwd = home / 'project'
cwd.mkdir()
for base, name in [(home, 'oar-user'), (cwd, 'oar-project')]:
    skill = base / '.factory/skills' / name / 'SKILL.md'
    skill.parent.mkdir(parents=True)
    skill.write_text(f'---\nname: {name}\ndescription: Synthetic fixture\n---\nPRIVATE BODY\n')
command = [str(args.command.resolve()), 'exec', '--input-format', 'stream-jsonrpc',
           '--output-format', 'stream-jsonrpc']
if args.trace:
    command = ['strace', '-f', '-e', 'trace=connect', '-o', str(output / 'connect.txt'), *command]
env = {'PATH': os.environ['PATH'], 'HOME': str(home), 'USERPROFILE': str(home), 'NO_PROXY': '*'}
process = subprocess.Popen(command, cwd=cwd, env=env, stdin=subprocess.PIPE,
                           stdout=subprocess.PIPE, stderr=subprocess.PIPE, start_new_session=True)
selector = selectors.DefaultSelector()
for name, stream in [('stdout', process.stdout), ('stderr', process.stderr)]:
    os.set_blocking(stream.fileno(), False)
    selector.register(stream, selectors.EVENT_READ, name)
request = {'jsonrpc': '2.0', 'factoryApiVersion': '1.0.0', 'type': 'request', 'id': 'skills',
           'method': 'droid.list_skills', 'params': {'includeContent': False}}
process.stdin.write((json.dumps(request) + '\n').encode())
process.stdin.flush()
data = {'stdout': b'', 'stderr': b''}
pending = b''
response = None
try:
    deadline = time.monotonic() + 30
    while response is None and time.monotonic() < deadline:
        for key, _ in selector.select(0.1):
            chunk = os.read(key.fileobj.fileno(), 65536)
            if not chunk:
                selector.unregister(key.fileobj)
                continue
            data[key.data] += chunk
            if key.data != 'stdout':
                continue
            pending += chunk
            while b'\n' in pending:
                line, pending = pending.split(b'\n', 1)
                try:
                    value = json.loads(line)
                except ValueError:
                    continue
                if value.get('type') == 'response' and value.get('id') == 'skills':
                    response = value
finally:
    os.killpg(process.pid, signal.SIGTERM)
    try:
        process.wait(timeout=5)
    except subprocess.TimeoutExpired:
        os.killpg(process.pid, signal.SIGKILL)
        process.wait()
    selector.close()
    for name, content in data.items():
        (output / f'{name}.txt').write_bytes(content)
files = sorted(str(p.relative_to(home)) for p in home.rglob('*') if p.is_file())
(output / 'files.json').write_text(json.dumps(files, indent=2))
assert response is not None, 'No native response before deadline'
assert 'error' not in response, 'Native query failed; inspect local stdout'
rows = response['result']['skills']
selected = {'count': len(rows), 'projectAvailable': response['result'].get('projectAvailable'),
            'contentOmitted': all('content' not in row and 'resources' not in row for row in rows),
            'sources': sorted({row['location'] for row in rows}),
            'markerNames': sorted(row['name'] for row in rows if row['name'].startswith('oar-'))}
(output / 'selected.json').write_text(json.dumps(selected, indent=2))
print(json.dumps(selected))
