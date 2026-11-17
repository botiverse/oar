#!/usr/bin/env python3
"""Compare CodeBuddy's exported catalog and executable protocols without a login."""
import argparse
import hashlib
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
import json
import os
from pathlib import Path
import selectors
import signal
import subprocess
import tempfile
import time
import threading

parser = argparse.ArgumentParser()
parser.add_argument('--binary', required=True, type=Path)
parser.add_argument('--server', required=True, type=Path,
                    help='server.mjs from the same-version installed CodeBuddy npm package')
parser.add_argument('--node', default='node')
parser.add_argument('--out', required=True, type=Path)
args = parser.parse_args()
binary, server = args.binary.resolve(), args.server.resolve()
args.out.mkdir(parents=True, exist_ok=True)
provider_requests = []


class Provider(BaseHTTPRequestHandler):
    def log_message(self, *unused):
        pass

    def do_POST(self):
        body = self.rfile.read(int(self.headers.get('Content-Length', '0')))
        provider_requests.append({'path': self.path, 'body': json.loads(body)})
        reply = b'{"error":{"message":"synthetic provider sentinel","type":"invalid_request_error"}}'
        self.send_response(400)
        self.send_header('Content-Type', 'application/json')
        self.send_header('Content-Length', str(len(reply)))
        self.end_headers()
        self.wfile.write(reply)


provider = ThreadingHTTPServer(('127.0.0.1', 0), Provider)
threading.Thread(target=provider.serve_forever, daemon=True).start()


def run(command, cwd, env, mode=None):
    process = subprocess.Popen(command, cwd=cwd, env=env, stdin=subprocess.PIPE,
                               stdout=subprocess.PIPE, stderr=subprocess.PIPE,
                               start_new_session=True)
    streams = selectors.DefaultSelector()
    raw = {'stdout': b'', 'stderr': b''}
    frames, buffer = [], b''
    for name, stream in [('stdout', process.stdout), ('stderr', process.stderr)]:
        os.set_blocking(stream.fileno(), False)
        streams.register(stream, selectors.EVENT_READ, name)

    def send(value):
        process.stdin.write((json.dumps(value) + '\n').encode())
        process.stdin.flush()

    if mode == 'acp':
        send({'jsonrpc': '2.0', 'id': 1, 'method': 'initialize', 'params': {
            'protocolVersion': 1, 'clientCapabilities': {},
            'clientInfo': {'name': 'oar-catalog-probe', 'version': '1'}}})
    elif mode == 'control':
        send({'type': 'control_request', 'request_id': 'catalog-probe',
              'request': {'subtype': 'initialize'}})
    else:
        process.stdin.close()
    deadline, answered = time.monotonic() + 30, None
    try:
        while time.monotonic() < deadline and streams.get_map():
            for key, _ in streams.select(0.1):
                chunk = os.read(key.fileobj.fileno(), 65536)
                if not chunk:
                    streams.unregister(key.fileobj)
                    continue
                raw[key.data] += chunk
                if key.data != 'stdout':
                    continue
                buffer += chunk
                while b'\n' in buffer:
                    line, buffer = buffer.split(b'\n', 1)
                    try:
                        frame = json.loads(line)
                    except ValueError:
                        continue
                    frames.append(frame)
                    if mode == 'acp' and frame.get('id') == 1:
                        send({'jsonrpc': '2.0', 'id': 2, 'method': 'session/new',
                              'params': {'cwd': str(cwd), 'mcpServers': []}})
                    if ((mode == 'acp' and frame.get('id') == 2)
                            or frame.get('type') == 'control_response'):
                        answered = time.monotonic()
            if answered and time.monotonic() - answered > 1:
                break
        if mode and answered is None:
            raise RuntimeError(f'{mode} protocol did not answer')
        if not mode and process.poll() is None:
            process.wait(timeout=2)
    finally:
        if process.poll() is None:
            os.killpg(process.pid, signal.SIGTERM)
            try:
                process.wait(timeout=5)
            except subprocess.TimeoutExpired:
                os.killpg(process.pid, signal.SIGKILL)
                process.wait()
        streams.close()
    return raw, frames, process.returncode


with tempfile.TemporaryDirectory(prefix='oar-codebuddy-catalog-') as tmp:
    home = Path(tmp)
    cwd = home / 'project'
    fixtures = [
        (home / '.codebuddy/skills', 'oar-user', ''),
        (cwd / '.codebuddy/skills', 'oar-project', ''),
        (cwd / '.codebuddy/skills', 'oar-hidden', 'user-invocable: false\n'),
        (cwd / '.codebuddy/skills', 'oar-manual', 'disable-model-invocation: true\n'),
        (cwd / '.claude/skills', 'oar-claude', ''),
    ]
    for root, name, flags in fixtures:
        path = root / name / 'SKILL.md'
        path.parent.mkdir(parents=True, exist_ok=True)
        path.write_text(f'---\nname: {name}\ndescription: Synthetic {name}\n{flags}'
                        '---\nOAR_BODY_NEVER_EXECUTE\n')
    env = {'PATH': os.environ['PATH'], 'HOME': str(home), 'USERPROFILE': str(home),
           'XDG_CONFIG_HOME': str(home / 'config'), 'DISABLE_TELEMETRY': '1',
           'CODEBUDDY_API_KEY': 'synthetic-oar-no-account',
           'CODEBUDDY_BASE_URL': f'http://127.0.0.1:{provider.server_port}/v1', 'NO_PROXY': '*'}
    version_raw, _, _ = run([str(binary), '--version'], cwd, env)
    control_raw, control, _ = run([str(binary), '--print', '--input-format',
        'stream-json', '--output-format', 'stream-json', '--no-session-persistence'],
        cwd, env, 'control')
    acp_raw, acp, _ = run([str(binary), '--acp', '--no-session-persistence'],
                          cwd, env, 'acp')
    script = home / 'catalog.mjs'
    script.write_text('''import { pathToFileURL } from 'node:url';
const native = await import(pathToFileURL(process.argv[2]).href);
const fs = new native.OverlayFs({ root: '/', mountPoint: '/' });
const catalog = await native.readSessionCatalog({ cwd: process.cwd(), fs,
  signal: AbortSignal.timeout(15000) });
process.stdout.write(JSON.stringify(catalog) + '\\n');
''')
    library_raw, _, library_exit = run([args.node, str(script), str(server)], cwd, env)
    before_print = len(provider_requests)
    print_raw, _, print_exit = run([str(binary), '--print', '/skills',
        '--output-format', 'json', '--no-session-persistence'], cwd, env)
    (args.out / 'provider-requests.txt').write_text(json.dumps(provider_requests, indent=2))
    provider.shutdown()
    provider.server_close()
    # Raw logs stay local. Published JSON excludes accounts, IDs, paths and bodies.
    for name, raw in [('version', version_raw), ('control', control_raw),
                      ('acp', acp_raw), ('library', library_raw), ('print', print_raw)]:
        for stream, data in raw.items():
            (args.out / f'{name}-{stream}.txt').write_bytes(data)
    response = next(frame['response'] for frame in control
                    if frame.get('type') == 'control_response')
    if response.get('subtype') != 'success' or library_exit != 0:
        raise RuntimeError('Native query failed; inspect local raw output')
    commands = response['response']['commands']
    snapshots = [frame['params']['update']['availableCommands'] for frame in acp
                 if frame.get('method') == 'session/update'
                 and frame['params']['update'].get('sessionUpdate') == 'available_commands_update']
    native_skills = [row for row in snapshots[-1] if row.get('_meta', {}).get('type') == 'skill']
    catalog = json.loads(library_raw['stdout'])
    result = {
        'version': version_raw['stdout'].decode().strip(),
        'platform': 'linux',
        'controlMarkerSkills': [row['name'] for row in commands if 'oar-' in row['name']],
        'acpSkillMetadata': native_skills,
        'librarySkills': [{key: row[key] for key in
            ('name', 'description', 'source', 'userInvocable', 'disableModelInvocation')
            if key in row} for row in catalog['skills']],
        'printSkills': {'exitCode': print_exit, 'stdoutBytes': len(print_raw['stdout']),
                        'providerAttempts': len(provider_requests) - before_print},
        'providerAttemptsBeforePrint': before_print,
        'rawSha256': {path.name: hashlib.sha256(path.read_bytes()).hexdigest()
                      for path in sorted(args.out.glob('*-*.txt'))},
        'binarySha256': hashlib.sha256(binary.read_bytes()).hexdigest(),
        'serverFacadeSha256': hashlib.sha256(server.read_bytes()).hexdigest(),
    }
    (args.out / 'result.json').write_text(json.dumps(result, indent=2) + '\n')
    print(json.dumps(result, indent=2))
