#!/usr/bin/env python3
"""Linux native Codex terminal controls, with a local Responses provider only.

python3 experiments/codex-background-terminals/probe.py --codex /path/to/codex --out /path/to/evidence
No OAR product code, real account, or external inference is used. Only processes
created by this probe are reclaimed; start-time identities guard against PID reuse.
"""
import argparse
import asyncio
import json
import os
from pathlib import Path
import re
import shlex
import signal
import subprocess
import sys
import tempfile
import threading
import time
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer


def proc(pid):
    try:
        raw = Path(f"/proc/{pid}/stat").read_text()
    except (FileNotFoundError, ProcessLookupError):
        return None
    # Permission and other observation errors deliberately propagate.
    fields = raw[raw.rfind(")") + 2:].split()
    return dict(pid=pid, state=fields[0], ppid=int(fields[1]), pgid=int(fields[2]),
                sid=int(fields[3]), started=int(fields[19]))


def same_alive(identity):
    current = proc(identity["pid"])
    return current is not None and current["started"] == identity["started"] and current["state"] != "Z"


async def until(predicate, label, timeout=15):
    deadline = time.monotonic() + timeout
    while not predicate():
        if time.monotonic() >= deadline:
            raise TimeoutError(label)
        await asyncio.sleep(.02)


TOOL = '''import json, os, subprocess, sys, time
child = subprocess.Popen([sys.executable, '-c', 'import time; time.sleep(120)'],
    start_new_session=sys.argv[2] == 'setsid', stdin=subprocess.DEVNULL,
    stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
with open(sys.argv[1], 'w') as f:
    json.dump({'parent': os.getpid(), 'child': child.pid}, f)
print('PROBE_TOOL_STARTED', flush=True)
time.sleep(120)
'''

MCP = '''import json, os, sys
with open(sys.argv[1], 'a') as f: f.write(str(os.getpid()) + '\\n')
for line in sys.stdin:
    msg = json.loads(line)
    if 'id' not in msg: continue
    if msg.get('method') == 'initialize':
        result = {'protocolVersion': msg['params']['protocolVersion'],
                  'capabilities': {'tools': {}}, 'serverInfo': {'name':'probe', 'version':'1'}}
    elif msg.get('method') == 'tools/list': result = {'tools': []}
    else: result = {}
    print(json.dumps({'jsonrpc':'2.0', 'id':msg['id'], 'result':result}), flush=True)
'''


class Provider:
    def __init__(self, home):
        self.home = home
        self.cases = {}
        self.requests = []
        self.release = threading.Event()
        owner = self

        class Handler(BaseHTTPRequestHandler):
            def log_message(self, *args):
                pass

            def do_POST(self):
                if not self.path.endswith('/responses'):
                    self.send_error(404)
                    return
                body = json.loads(self.rfile.read(int(self.headers['content-length'])))
                users = [x for x in body.get('input', []) if x.get('role') == 'user']
                matches = re.findall(r'PROBE:([a-z0-9_-]+)', json.dumps(users))
                if not matches:
                    self.send_error(400, 'missing probe marker')
                    return
                key = matches[-1]
                case = owner.cases[key]
                stage = case['requests']
                case['requests'] += 1
                owner.requests.append(dict(key=key, stage=stage, body=body))
                self.send_response(200)
                self.send_header('Content-Type', 'text/event-stream')
                self.end_headers()
                sequence = 0
                rid = f'resp-{key}-{stage}'

                def send(kind, **fields):
                    nonlocal sequence
                    frame = dict(type=kind, sequence_number=sequence, **fields)
                    sequence += 1
                    self.wfile.write(f'event: {kind}\ndata: {json.dumps(frame)}\n\n'.encode())
                    self.wfile.flush()

                def finish(items):
                    send('response.completed', response=dict(id=rid, object='response', status='completed',
                         model='gpt-5.1', output=items, usage=dict(input_tokens=30, output_tokens=10, total_tokens=40)))

                try:
                    send('response.created', response=dict(id=rid, object='response', status='in_progress', output=[]))
                    if stage == 0:
                        command = ' '.join(shlex.quote(x) for x in [sys.executable, str(home / 'tool.py'),
                                           str(home / (key + '.json')), case['child']])
                        item = dict(id=rid+'-tool', type='function_call', call_id=key, name='exec_command',
                                    arguments=json.dumps(dict(cmd=command, yield_time_ms=case['yield_ms'], max_output_tokens=200)))
                        send('response.output_item.added', output_index=0, item=item)
                        send('response.output_item.done', output_index=0, item=item)
                        finish([item])
                    elif case['hold']:
                        owner.release.wait(60)
                    else:
                        item = dict(id=rid+'-text', type='message', role='assistant', status='completed',
                                    content=[dict(type='output_text', text='STARTED', annotations=[])])
                        send('response.output_item.added', output_index=0, item=item)
                        send('response.output_item.done', output_index=0, item=item)
                        finish([item])
                except (BrokenPipeError, ConnectionResetError):
                    pass

        self.server = ThreadingHTTPServer(('127.0.0.1', 0), Handler)
        self.server.daemon_threads = True
        self.thread = threading.Thread(target=self.server.serve_forever, daemon=True)
        self.thread.start()

    def close(self):
        self.release.set()
        self.server.shutdown()
        self.server.server_close()


class Rpc:
    def __init__(self, child):
        self.child = child
        self.frames = []
        self.sent = []
        self.pending = {}
        self.next_id = 1
        self.reader = asyncio.create_task(self.read())

    async def read(self):
        while line := await self.child.stdout.readline():
            msg = json.loads(line)
            self.frames.append(dict(at=time.monotonic(), message=msg))
            future = self.pending.pop(msg.get('id'), None) if 'method' not in msg else None
            if future and not future.done():
                future.set_result(msg)

    async def call(self, method, params):
        request_id = self.next_id
        self.next_id += 1
        message = dict(id=request_id, method=method, params=params)
        self.sent.append(dict(at=time.monotonic(), message=message))
        future = asyncio.get_running_loop().create_future()
        self.pending[request_id] = future
        self.child.stdin.write((json.dumps(message) + '\n').encode())
        await self.child.stdin.drain()
        return await asyncio.wait_for(future, 20)

    def ended(self, turn):
        return next((x['message']['params']['turn'] for x in self.frames
                     if x['message'].get('method') == 'turn/completed'
                     and x['message']['params']['turn']['id'] == turn), None)


async def run_case(binary, output, label, foreground, detached, action, scope=False, pre_interrupt=False, early=False):
    case_dir = output / label
    case_dir.mkdir(parents=True, exist_ok=True)
    result = dict(label=label, foreground=foreground, detached=detached, action=action,
                  scope=scope, pre_interrupt=pre_interrupt, early=early)
    with tempfile.TemporaryDirectory(prefix='oar-native-terminals-') as tmp:
        home = Path(tmp)
        (home / 'tool.py').write_text(TOOL)
        (home / 'mcp.py').write_text(MCP)
        provider = Provider(home)
        port = provider.server.server_address[1]
        (home / 'config.toml').write_text('\n'.join([
            'model = "gpt-5.1"', 'model_provider = "probe"', 'sandbox_mode = "danger-full-access"',
            'approval_policy = "never"', '[features]', 'code_mode = false', '[model_providers.probe]',
            'name = "probe"', f'base_url = "http://127.0.0.1:{port}/v1"',
            'env_key = "OPENAI_API_KEY"', 'wire_api = "responses"', '[mcp_servers.probe]',
            f'command = {json.dumps(sys.executable)}',
            'args = ' + json.dumps([str(home / 'mcp.py'), str(home / 'mcp-pids')]),
        ]))
        env = {k: os.environ[k] for k in ('PATH', 'LANG', 'LC_ALL', 'TZ') if k in os.environ}
        env.update(HOME=tmp, CODEX_HOME=tmp, XDG_CONFIG_HOME=tmp+'/config', XDG_DATA_HOME=tmp+'/data',
                   XDG_CACHE_HOME=tmp+'/cache', OPENAI_API_KEY='local-probe', NO_PROXY='*')
        stderr = open(case_dir / 'stderr.txt', 'wb')
        child = await asyncio.create_subprocess_exec(binary, 'app-server', '--listen', 'stdio://',
                    env=env, cwd=tmp, stdin=asyncio.subprocess.PIPE, stdout=asyncio.subprocess.PIPE,
                    stderr=stderr, limit=2**22)
        rpc = Rpc(child)
        identities = {}

        async def thread():
            reply = await rpc.call('thread/start', dict(cwd=tmp, approvalPolicy='never'))
            tid = reply['result']['thread']['id']
            return tid

        async def start(tid, key, foreground=False, detached=False, hold=False):
            provider.cases[key] = dict(requests=0, yield_ms=30000 if foreground else 1000,
                                       child='setsid' if detached else 'normal', hold=hold)
            reply = await rpc.call('turn/start', dict(threadId=tid, input=[dict(type='text', text='PROBE:'+key)]))
            turn_id = reply['result']['turn']['id']
            marker = home / (key + '.json')
            await until(lambda: marker.exists() and marker.stat().st_size > 0, key+' process marker')
            pids = json.loads(marker.read_text())
            identities[key] = {name: proc(pid) for name, pid in pids.items()}
            assert all(identities[key].values())
            assert all(same_alive(x) for x in identities[key].values())
            if detached:
                assert identities[key]['child']['sid'] == identities[key]['child']['pid']
                assert identities[key]['parent']['pgid'] != identities[key]['child']['pgid']
            if not early:
                await until(lambda: any(x['message'].get('method') == 'item/started'
                            and x['message']['params'].get('turnId') == turn_id
                            and x['message']['params']['item']['type'] == 'commandExecution'
                            for x in rpc.frames), key+' native command start')
                await asyncio.sleep(.05)
            if not foreground:
                await until(lambda: provider.cases[key]['requests'] >= 2, key+' yielded')
                if not hold:
                    await until(lambda: rpc.ended(turn_id) is not None, key+' ended')
            return turn_id

        def snapshot():
            return {key: {name: dict(identity=identity, current=proc(identity['pid']), alive=same_alive(identity))
                          for name, identity in group.items()} for key, group in identities.items()}

        try:
            result['initialize'] = await rpc.call('initialize', dict(clientInfo=dict(name='oar-terminal-probe', version='1'),
                                                   capabilities=dict(experimentalApi=True)))
            child.stdin.write(b'{"method":"initialized","params":{}}\n')
            await child.stdin.drain()
            target = await thread()
            if scope:
                await start(target, 'old')
                peer = await thread()
                await start(peer, 'peer')
            target_turn = await start(target, 'target', foreground, detached, hold=True)
            await until(lambda: (home / 'mcp-pids').exists(), 'native stdio MCP startup')
            mcp_ids = [proc(int(x)) for x in (home / 'mcp-pids').read_text().splitlines()]
            assert all(mcp_ids), 'MCP identities observed before cancellation'
            identities['mcp'] = {str(i): x for i, x in enumerate(mcp_ids)}
            result['before'] = snapshot()
            result['list_before_interrupt'] = await rpc.call('thread/backgroundTerminals/list', dict(threadId=target))
            if not pre_interrupt:
                result['interrupt'] = await rpc.call('turn/interrupt', dict(threadId=target, turnId=target_turn))
                await until(lambda: rpc.ended(target_turn) is not None, 'interrupt completion')
                result['target_turn'] = rpc.ended(target_turn)
                await asyncio.sleep(.2)
            result['after_interrupt'] = snapshot()
            listed = await rpc.call('thread/backgroundTerminals/list', dict(threadId=target))
            result['list_before_action'] = listed
            candidates = [x for x in listed.get('result', {}).get('data', []) if 'target.json' in x.get('command', '')]
            result['target_candidates'] = len(candidates)
            at = time.monotonic()
            if action == 'terminate' and candidates:
                assert len(candidates) == 1
                result['action_reply'] = await rpc.call('thread/backgroundTerminals/terminate',
                            dict(threadId=target, processId=candidates[0]['processId']))
            elif action == 'clean':
                result['action_reply'] = await rpc.call('thread/backgroundTerminals/clean', dict(threadId=target))
            else:
                result['action_not_sent'] = 'target absent from native list'
            result['reply_ms'] = (time.monotonic() - at) * 1000
            result['observations'] = []
            for deadline in (.1, 1, 2):
                await asyncio.sleep(max(0, deadline - (time.monotonic() - at)))
                result['observations'].append(dict(ms=(time.monotonic()-at)*1000, processes=snapshot()))
            result['list_after_action'] = await rpc.call('thread/backgroundTerminals/list', dict(threadId=target))
            result['app_server_alive'] = child.returncode is None
            if scope:
                result['peer_list_after_action'] = await rpc.call('thread/backgroundTerminals/list', dict(threadId=peer))
            if pre_interrupt:
                result['interrupt_after_action'] = await rpc.call('turn/interrupt', dict(threadId=target, turnId=target_turn))
            result['error'] = None
        except BaseException as error:
            result['error'] = f'{type(error).__name__}: {error}'
        finally:
            result['frames'] = rpc.frames
            result['sent'] = rpc.sent
            result['provider_requests'] = provider.requests
            # Close the app-server and reclaim only our still-identical probe processes.
            provider.release.set()
            if child.returncode is None:
                child.stdin.close()
                try:
                    await asyncio.wait_for(child.wait(), 3)
                except asyncio.TimeoutError:
                    child.terminate()
                    try:
                        await asyncio.wait_for(child.wait(), 3)
                    except asyncio.TimeoutError:
                        child.kill()
                        await child.wait()
            for group in identities.values():
                for identity in group.values():
                    if same_alive(identity):
                        os.kill(identity['pid'], signal.SIGKILL)
            await asyncio.sleep(.1)
            result['probe_cleanup_remaining'] = [x for group in identities.values() for x in group.values() if same_alive(x)]
            await rpc.reader
            stderr.close()
            provider.close()
            sanitized = json.dumps(result, indent=2).replace(tmp, '<probe-home>')
            (case_dir / 'result.json').write_text(sanitized+'\n')
            result = json.loads(sanitized)
            text = (case_dir / 'stderr.txt').read_text()
            (case_dir / 'stderr.txt').write_text(text.replace(tmp, '<probe-home>'))
    print(json.dumps(dict(label=label, error=result.get('error'), candidates=result.get('target_candidates'),
                         action_reply=result.get('action_reply'), cleanup_remaining=len(result['probe_cleanup_remaining']))), flush=True)
    return result


async def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--codex', required=True)
    parser.add_argument('--out', required=True)
    parser.add_argument('--case')
    args = parser.parse_args()
    if sys.platform != 'linux':
        raise SystemExit('This observer requires Linux procfs; it makes no Windows/macOS claim.')
    output = Path(args.out).resolve()
    output.mkdir(parents=True, exist_ok=True)
    version = subprocess.check_output([args.codex, '--version'], text=True).strip()
    matrix = [(f'{phase}-{child}-{action}', phase == 'foreground', child == 'setsid', action, False, False)
              for phase in ('foreground', 'yielded') for child in ('normal', 'setsid') for action in ('terminate', 'clean')]
    matrix += [('scope-clean', True, True, 'clean', True, False),
               ('scope-terminate', True, True, 'terminate', True, False),
               ('active-foreground-terminate', True, False, 'terminate', False, True),
               ('launching-setsid-terminate', True, True, 'terminate', False, False, True)]
    if args.case is not None and args.case not in [row[0] for row in matrix]:
        parser.error('unknown --case')
    results = []
    for row in matrix:
        if args.case is None or args.case == row[0]:
            results.append(await run_case(str(Path(args.codex).resolve()), output, *row))
    (output / 'summary.json').write_text(json.dumps(dict(version=version, platform=sys.platform,
        cases=[{k:v for k,v in result.items() if k not in ('frames','sent','provider_requests')} for result in results]), indent=2)+'\n')
    if any(r['error'] or r['probe_cleanup_remaining'] for r in results):
        raise SystemExit(1)


if __name__ == '__main__':
    asyncio.run(main())
