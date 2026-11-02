"""Drive an external, import-free DSH plugin through the real profile launcher.

Only the model endpoint and one tool are fixtures. No accounts or ACP messages.
Usage: python experiments/dsh-plugin/run.py --runtime /prefix/node_modules/@deepseek-ai/dsh --output /tmp/evidence
"""
import argparse
import hashlib
import http.server
import json
import os
from pathlib import Path
import re
import signal
import subprocess
import threading
import time

HERE = Path(__file__).resolve().parent


def snapshot(root):
    return {str(p.relative_to(root)): hashlib.sha256(p.read_bytes()).hexdigest()
            for p in sorted(root.rglob('*')) if p.is_file()}


def changes(before, after):
    return {'added': sorted(after.keys() - before.keys()),
            'removed': sorted(before.keys() - after.keys()),
            'changed': sorted(k for k in before.keys() & after.keys() if before[k] != after[k])}


class Provider(http.server.BaseHTTPRequestHandler):
    def log_message(self, *_args):
        pass

    def do_POST(self):
        body = json.loads(self.rfile.read(int(self.headers['Content-Length'])))
        self.server.requests.append(body)
        user_text = '\n'.join(str(m['content']) for m in body['messages'] if m['role'] == 'user')
        tool_results = [m for m in body['messages'] if m['role'] == 'tool']
        call = None
        if 'CHILD_ONLY' in user_text:
            text = 'child native answer'
        elif (('CWD_AFTER' in user_text and len(tool_results) == 1) or ('CWD_BEFORE' in user_text and not tool_results)):
            call = ('bash', {'description': 'Report native tool working directory', 'command': 'pwd'})
            text = ''
        elif 'SPAWN_PROBE' in user_text and not tool_results:
            call = ('subagent', {'description': 'Native child probe', 'prompt': 'CHILD_ONLY'})
            text = ''
        else:
            label = re.search(r'PROBE_(BASIC|STEER|INJECT|QUEUE|CANCEL|PERSIST)', user_text)
            if label and not tool_results:
                tag = label.group(0)
                call = ('oar_probe_echo', {'value': tag, 'hold': tag != 'PROBE_BASIC'})
            text = 'native final answer'
        self.send_response(200)
        self.send_header('Content-Type', 'text/event-stream')
        self.end_headers()
        chunks = [{'choices': [{'index': 0, 'delta': {'role': 'assistant', 'reasoning_content': 'native thought'}, 'finish_reason': None}]}]
        if call:
            name, args = call
            encoded = json.dumps(args)
            split = len(encoded) // 2
            chunks.extend([
                {'choices': [{'index': 0, 'delta': {'tool_calls': [{'index': 0, 'id': 'probe_call', 'type': 'function', 'function': {'name': name, 'arguments': encoded[:split]}}]}, 'finish_reason': None}]},
                {'choices': [{'index': 0, 'delta': {'tool_calls': [{'index': 0, 'function': {'arguments': encoded[split:]}}]}, 'finish_reason': None}]},
            ])
        else:
            chunks.extend([{'choices': [{'index': 0, 'delta': {'content': part}, 'finish_reason': None}]} for part in [text[:6], text[6:]]])
        chunks.append({'choices': [{'index': 0, 'delta': {}, 'finish_reason': 'tool_calls' if call else 'stop'}],
                       'usage': {'prompt_tokens': 100, 'completion_tokens': 12, 'total_tokens': 112}})
        try:
            for chunk in chunks:
                self.wfile.write(('data: ' + json.dumps({'id': 'probe-response', 'object': 'chat.completion.chunk', 'created': 1, 'model': 'probe-model', **chunk}) + '\n\n').encode())
                self.wfile.flush()
            self.wfile.write(b'data: [DONE]\n\n')
        except (BrokenPipeError, ConnectionResetError):
            pass


class Bridge:
    def __init__(self, runtime, root, patch, number, process_cwd=None):
        self.frames = []
        self.invalid = []
        self.condition = threading.Condition()
        self.number = number
        self.command_id = 0
        self.stderr_path = root / f'stderr-{number}.txt'
        self.stderr = self.stderr_path.open('w')
        # Pass only process-launch basics, never ambient provider credentials.
        env = {key: os.environ[key] for key in ['PATH', 'LANG', 'LC_ALL', 'TMPDIR'] if key in os.environ}
        env.update(HOME=str(root / 'home'), DSH_HOME=str(root / 'dsh'), DSH_TELEMETRY_DISABLED='1',
                   DSH_PERMISSION_MODE='danger-full-access', OAR_DSH_PROBE_KEY='fixture-only')
        self.process = subprocess.Popen(['node', str(runtime / 'lib/bin.js'), '--profile', 'acp', '--patch', str(patch)],
                                        cwd=process_cwd or root, env=env, stdin=subprocess.PIPE, stdout=subprocess.PIPE,
                                        stderr=self.stderr, text=True, start_new_session=True)
        self.reader = threading.Thread(target=self.read, daemon=True)
        self.reader.start()

    def read(self):
        for line in self.process.stdout:
            with self.condition:
                try:
                    self.frames.append(json.loads(line))
                except json.JSONDecodeError:
                    self.invalid.append(line)
                self.condition.notify_all()
        with self.condition:
            self.condition.notify_all()

    def wait(self, predicate, after=0, timeout=30):
        deadline = time.monotonic() + timeout
        with self.condition:
            while True:
                for frame in self.frames[after:]:
                    if predicate(frame):
                        return frame
                remaining = deadline - time.monotonic()
                if remaining <= 0 or self.process.poll() is not None:
                    raise AssertionError({'waiting': 'native evidence', 'exit': self.process.poll(),
                                          'tail': self.frames[-5:], 'stderr': self.stderr_path.read_text()[-2500:]})
                self.condition.wait(min(remaining, 0.2))

    def call(self, method, expect_error=False, **fields):
        self.command_id += 1
        request_id = f'{self.number}-{self.command_id}'
        self.process.stdin.write(json.dumps({'id': request_id, 'method': method, **fields}) + '\n')
        self.process.stdin.flush()
        result = self.wait(lambda f: f.get('id') == request_id and f['type'] == 'response')
        if expect_error:
            assert 'error' in result, result
            return result
        assert 'error' not in result, result
        return result['result']

    def end(self, session_id, after=0):
        return self.wait(lambda f: f.get('sessionId') == session_id and f.get('event', {}).get('type') == 'turn/end', after)

    def held(self, tag):
        return self.wait(lambda f: f.get('action') == 'tool-start' and f.get('args', {}).get('value') == tag)

    def stop(self):
        if self.process.poll() is None:
            self.process.stdin.close()
            try:
                self.process.wait(timeout=8)
            except subprocess.TimeoutExpired:
                os.killpg(self.process.pid, signal.SIGKILL)
                self.process.wait()
        self.reader.join(timeout=2)
        self.stderr.close()


def durable(frame, kind):
    return frame.get('channel') == 'session/event' and frame.get('event', {}).get('type') == kind


def body_text(request):
    return json.dumps(request['messages'])


def run(runtime, root):
    root.mkdir(parents=True, exist_ok=False)
    version = json.loads((runtime / 'package.json').read_text())['version']
    server = http.server.ThreadingHTTPServer(('127.0.0.1', 0), Provider)
    server.requests = []
    threading.Thread(target=server.serve_forever, daemon=True).start()
    route = {'api': 'openai-completions', 'apiKeyEnv': 'OAR_DSH_PROBE_KEY',
             'baseURL': f'http://127.0.0.1:{server.server_port}/v1', 'compat': {'thinkingFormat': 'deepseek'},
             'models': [{'id': 'probe-model', 'contextWindow': 128000, 'maxTokens': 4096}]}
    overlays = [{'id': 'acp', 'disabled': True}, {'id': 'llm-deepseek', 'disabled': True},
                {'id': 'session-log-deepseek', 'disabled': True}, {'id': 'plugin-package-inventory-deepseek', 'disabled': True},
                {'id': 'llm-pi-ai', 'config': {'providers': {'oar-probe': route}}}]
    patch = root / 'invocation.json'
    patch.write_text(json.dumps(overlays + [{'insert': [{'id': 'oar-dsh-probe', 'name': str(HERE / 'bridge/load.mjs')}]}]))
    result = {'version': version, 'platform': 'linux-x64', 'checks': {}, 'launches': []}
    before = snapshot(root / 'dsh')
    load = Bridge(runtime, root, patch, 0)
    try:
        result['loading'] = load.wait(lambda f: f['type'] == 'ready')
    finally:
        load.stop()
    result['coldHomeChanges'] = changes(before, snapshot(root / 'dsh'))
    result['launches'].append({'number': 0, 'exit': load.process.returncode, 'frames': load.frames, 'stderr': load.stderr_path.read_text()})
    # Simulate existing user settings inside the profile; the invocation overlay must not rewrite them.
    profile = root / 'dsh/profiles/acp/cordis.patch.yml'
    profile.write_text('# User-owned provider selection; preserve verbatim.\n' + json.dumps([
        {'id': 'llm-pi-ai', 'config': {'providers': {'oar-probe': route}}}
    ], indent=2) + '\n')
    (root / 'dsh/cordis.patch.yml').write_text(json.dumps([{'id': 'system-prompt', 'config': {'personaPrefix': 'OAR_USER_HOME_PATCH_MARKER'}}]) + '\n')
    home_patch_before = (root / 'dsh/cordis.patch.yml').read_bytes()
    config_before = snapshot(root / 'dsh/profiles')
    warm_before = snapshot(root / 'dsh')
    patch.write_text(json.dumps([row for row in overlays if row['id'] != 'llm-pi-ai'] + [{'insert': [{'id': 'oar-dsh-probe', 'name': str(HERE / 'bridge/native.mjs'), 'config': {'version': version}}]}]))
    bridge = Bridge(runtime, root, patch, 1)
    try:
        handshake = bridge.wait(lambda f: f['type'] == 'ready')
        assert bridge.frames[0] == handshake, bridge.frames[:3]
        assert all(handshake['services']['agents'].values()), handshake
        result['handshake'] = handshake
        cwd = root / 'project-a'
        cwd.mkdir()
        for scenario in ['basic', 'steer', 'inject', 'queue', 'cancel']:
            session_id = f'oar-{scenario}'
            opened = bridge.call('new', sessionId=session_id, cwd=str(cwd))
            assert all(opened['methods'].values()) and all(opened['inboxMethods'].values()), opened
            if scenario == 'basic':
                model = bridge.call('model-current', expect_error=not opened['modelCurrent'], sessionId=session_id)
                if not opened['modelCurrent']:
                    assert model['code'] == 'native_method_unavailable' and model['capability'] == 'model-current', model
                result['modelCurrent'] = model
                result['checks']['nativeCapabilityInventory'] = 'passed'
            start = len(bridge.frames)
            bridge.call('prompt', sessionId=session_id, text=f'PROBE_{scenario.upper()}')
            if scenario == 'basic':
                end = bridge.end(session_id, start)
                assert end['event']['data']['reason']['kind'] == 'completed', end
                result['checks']['toolTurn'] = 'passed'
                continue
            bridge.held(f'PROBE_{scenario.upper()}')
            if scenario in ['steer', 'inject']:
                count = len(server.requests)
                bridge.call(scenario, sessionId=session_id, text=f'{scenario.upper()}_MARKER')
                snapshot_now = bridge.call('snapshot', sessionId=session_id)
                assert snapshot_now['status'] == 'running', snapshot_now
                assert len(snapshot_now['nextStep']) == 1, snapshot_now
                bridge.call('release', value=f'PROBE_{scenario.upper()}')
                end = bridge.end(session_id, start)
                assert end['event']['data']['turn'] == 1, end
                assert any(f'{scenario.upper()}_MARKER' in body_text(r) for r in server.requests[count:]), server.requests[count:]
                result['checks'][scenario + 'DuringTool'] = 'passed'
            elif scenario == 'queue':
                bridge.call('queue', sessionId=session_id, text='QUEUED_KEEP')
                removable = bridge.call('queue', sessionId=session_id, text='QUEUED_REMOVE')
                pending = bridge.call('snapshot', sessionId=session_id)
                assert len(pending['nextTurn']) == 2, pending
                assert bridge.call('withdraw', sessionId=session_id, messageId=removable['messageId'])['removed'] is True
                bridge.call('release', value='PROBE_QUEUE')
                bridge.wait(lambda f: f.get('sessionId') == session_id and durable(f, 'turn/end') and f['event']['data']['turn'] == 2, start)
                assert not any('QUEUED_REMOVE' in body_text(r) for r in server.requests), 'withdrawn input reached provider'
                result['checks']['queueAndWithdraw'] = 'passed'
            else:
                bridge.call('queue', sessionId=session_id, text='CANCELLED_QUEUE')
                bridge.call('cancel', sessionId=session_id)
                end = bridge.end(session_id, start)
                result['cancelReason'] = end['event']['data']['reason']
                assert end['event']['data']['reason']['kind'] == 'aborted', end
                pending = bridge.call('snapshot', sessionId=session_id)
                assert pending['nextTurn'] == [] and pending['nextStep'] == [], pending
                assert not any('CANCELLED_QUEUE' in body_text(r) for r in server.requests)
                result['checks']['cancel'] = 'passed'
        bridge.call('new', sessionId='oar-idle-inject', cwd=str(cwd))
        request_count = len(server.requests)
        bridge.call('inject', sessionId='oar-idle-inject', text='IDLE_INJECT')
        idle = bridge.call('snapshot', sessionId='oar-idle-inject')
        assert idle['status'] == 'idle' and len(idle['nextStep']) == 1, idle
        assert len(server.requests) == request_count
        bridge.call('prompt', sessionId='oar-idle-inject', text='WAKE_INJECT')
        bridge.end('oar-idle-inject')
        assert any('IDLE_INJECT' in body_text(r) and 'WAKE_INJECT' in body_text(r) for r in server.requests[request_count:])
        result['checks']['idleInject'] = 'passed'
        bridge.call('new', sessionId='oar-cwd', cwd=str(cwd))
        bridge.call('prompt', sessionId='oar-cwd', text='CWD_BEFORE')
        bridge.end('oar-cwd')
        cwd_result = bridge.wait(lambda f: f.get('sessionId') == 'oar-cwd' and durable(f, 'tool/result'))
        assert cwd_result['event']['data']['message']['isError'] is False, cwd_result
        assert cwd_result['event']['data']['message']['content'] == [{'type': 'text', 'text': str(cwd) + '\n'}], cwd_result
        result['checks']['nativeToolCwd'] = 'passed'
        # Real native subagent tool, whose model still uses the local fixture provider.
        bridge.call('new', sessionId='oar-parent', cwd=str(cwd))
        bridge.call('prompt', sessionId='oar-parent', text='SPAWN_PROBE')
        child_start = bridge.wait(lambda f: f.get('channel') == 'subagent/start')
        child_end = bridge.wait(lambda f: f.get('channel') == 'subagent/end')
        child_id = child_start['info']['id']
        assert child_end['info']['id'] == child_id and child_end['info']['stopReason'] == 'completed', child_end
        catalog = bridge.wait(lambda f: f.get('sessionId') == 'oar-parent' and durable(f, 'subagent/catalog') and f['event']['data']['childId'] == child_id)
        child_terminal = bridge.end(child_id)
        assert child_terminal['event']['data']['reason']['kind'] == 'completed', child_terminal
        result['child'] = {'start': child_start, 'end': child_end, 'catalog': catalog, 'terminal': child_terminal}
        result['checks']['subagent'] = 'passed'
        listed = bridge.call('list')
        assert any(item['header']['id'] == 'oar-basic' for item in listed), listed
        result['checks']['sessionList'] = 'passed'
        stored = bridge.call('history', sessionId='oar-basic')
        native = [f['event'] for f in bridge.frames if f.get('sessionId') == 'oar-basic' and f.get('channel') == 'session/event']
        assert stored['events'] == native, {'stored': stored, 'emitted': native}
        result['checks']['durableEventsUnchanged'] = 'passed'
        chunks = [f['frame']['chunk']['type'] for f in bridge.frames if f.get('channel') == 'agent/assistant-stream' and f['frame']['type'] == 'chunk']
        for kind in ['text-delta', 'reasoning-delta', 'tool-call-delta', 'usage', 'finish']:
            assert kind in chunks, {'missing': kind, 'chunks': chunks}
        result['checks']['nativeStreamKinds'] = 'passed'
        bridge.call('close-all')
    finally:
        bridge.stop()
        result['launches'].append({'number': 1, 'exit': bridge.process.returncode, 'frames': bridge.frames, 'stderr': bridge.stderr_path.read_text()})
        result['requests'] = server.requests
        (root / 'evidence.json').write_text(json.dumps(result, indent=2))
    different_cwd = root / 'different-project'
    different_cwd.mkdir()
    resumed = Bridge(runtime, root, patch, 2, different_cwd)
    try:
        resumed.wait(lambda f: f['type'] == 'ready')
        # Native resume has no cwd override; launch from a different process cwd.
        old = resumed.call('resume', sessionId='oar-basic')
        assert old['header']['cwd'] == str(cwd), old
        resumed.call('prompt', sessionId='oar-basic', text='RESUME_MARKER')
        resumed.end('oar-basic')
        assert any('PROBE_BASIC' in body_text(r) and 'RESUME_MARKER' in body_text(r) for r in server.requests)
        result['checks']['crossProcessResume'] = 'passed'
        result['resumeCwd'] = old['header']['cwd']
        resumed.call('resume', sessionId='oar-cwd')
        resumed.call('prompt', sessionId='oar-cwd', text='CWD_AFTER')
        resumed.end('oar-cwd')
        cwd_result = resumed.wait(lambda f: f.get('sessionId') == 'oar-cwd' and durable(f, 'tool/result'))
        assert cwd_result['event']['data']['message']['isError'] is False, cwd_result
        assert cwd_result['event']['data']['message']['content'] == [{'type': 'text', 'text': str(cwd) + '\n'}], cwd_result
        result['checks']['resumedNativeToolCwd'] = 'passed'
        resumed.call('close-all')
    finally:
        resumed.stop()
        result['launches'].append({'number': 2, 'exit': resumed.process.returncode, 'frames': resumed.frames, 'stderr': resumed.stderr_path.read_text()})
        result['profileChanges'] = changes(config_before, snapshot(root / 'dsh/profiles'))
        result['warmHomeChanges'] = changes(warm_before, snapshot(root / 'dsh'))
        result['requests'] = server.requests
        (root / 'evidence.json').write_text(json.dumps(result, indent=2))
        server.shutdown()
    assert (root / 'dsh/cordis.patch.yml').read_bytes() == home_patch_before
    assert any('OAR_USER_HOME_PATCH_MARKER' in body_text(r) for r in server.requests)
    result['checks']['userHomeAndProviderApplied'] = 'passed'
    assert '@deepseek-ai/' not in (HERE / 'bridge/native.mjs').read_text()
    result['checks']['zeroDshRuntimeImports'] = 'passed'
    assert result['profileChanges'] == {'added': [], 'removed': [], 'changed': []}, result['profileChanges']
    assert all(item['exit'] == 0 for item in result['launches']), result['launches']
    assert not bridge.invalid and not resumed.invalid
    result['checks']['existingProfileUnchanged'] = 'passed'
    (root / 'evidence.json').write_text(json.dumps(result, indent=2))
    print(json.dumps({'version': version, 'checks': result['checks'], 'output': str(root / 'evidence.json')}))


if __name__ == '__main__':
    parser = argparse.ArgumentParser()
    parser.add_argument('--runtime', type=Path, required=True)
    parser.add_argument('--output', type=Path, required=True)
    args = parser.parse_args()
    run(args.runtime.resolve(), args.output.resolve())
