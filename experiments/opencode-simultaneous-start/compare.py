"""Compare synchronized native ACP startup with one or two prepared data directories."""
import argparse
import json
import os
import queue
import signal
import subprocess
import sys
import tempfile
import threading
import time
from collections import Counter
from concurrent.futures import ThreadPoolExecutor
from datetime import datetime, timezone
from pathlib import Path


class Worker:
    def __init__(self, root, data, binary):
        self.cwd = root / 'project'
        self.stderr = root / 'stderr.txt'
        self.data = data
        self.binary = binary
        self.env = {k: v for k, v in os.environ.items() if k.upper() in {
            'PATH', 'SYSTEMROOT', 'WINDIR', 'COMSPEC', 'PATHEXT', 'TEMP', 'TMP', 'TMPDIR', 'LANG'}}
        locations = dict(HOME=root / 'home', USERPROFILE=root / 'home', XDG_DATA_HOME=data,
                         XDG_CONFIG_HOME=root / 'config', XDG_CACHE_HOME=root / 'cache',
                         XDG_STATE_HOME=root / 'state', APPDATA=root / 'roaming', LOCALAPPDATA=root / 'local')
        for path in [*locations.values(), self.cwd]:
            path.mkdir(parents=True, exist_ok=True)
        self.env.update({k: str(v) for k, v in locations.items()})
        for flag in ['MODELS_FETCH', 'AUTOUPDATE', 'LSP_DOWNLOAD', 'DEFAULT_PLUGINS', 'CLAUDE_CODE']:
            self.env['OPENCODE_DISABLE_' + flag] = '1'
        self.env['CI'] = '1'

    def start(self, barrier=None):
        messages = queue.Queue()
        with self.stderr.open('w') as err:
            if barrier:
                barrier.wait(timeout=10)
            self.started = time.perf_counter_ns()
            self.proc = subprocess.Popen([self.binary, 'acp'], cwd=self.cwd, env=self.env,
                                         stdin=subprocess.PIPE, stdout=subprocess.PIPE, stderr=err,
                                         start_new_session=os.name != 'nt')
        self.reader = threading.Thread(target=self.read_stdout, args=(messages,), daemon=True)
        self.reader.start()
        deadline = time.monotonic() + 20
        for request_id, (method, params) in enumerate([
                ('initialize', {'protocolVersion': 1, 'clientCapabilities': {}}),
                ('session/new', {'cwd': str(self.cwd), 'mcpServers': []})], 1):
            request = {'jsonrpc': '2.0', 'id': request_id, 'method': method, 'params': params}
            try:
                self.proc.stdin.write((json.dumps(request) + '\n').encode())
                self.proc.stdin.flush()
                while True:
                    reply = messages.get(timeout=max(0, deadline - time.monotonic()))
                    if reply is None:
                        return {'phase': method, 'result': 'stdout_closed'}
                    if reply.get('id') == request_id and ('result' in reply or 'error' in reply):
                        if 'error' in reply:
                            return {'phase': method, 'result': 'rpc_error', 'code': reply['error'].get('code')}
                        value = reply['result']
                        if method == 'initialize' and value.get('protocolVersion') != 1:
                            return {'phase': method, 'result': 'unexpected_protocol'}
                        if method == 'session/new' and not value.get('sessionId'):
                            return {'phase': method, 'result': 'missing_session_id'}
                        break
            except (BrokenPipeError, OSError):
                return {'phase': method, 'result': 'pipe_error'}
            except queue.Empty:
                return {'phase': method, 'result': 'timeout'}
        return {'phase': 'session/new', 'result': 'ready'}

    def read_stdout(self, messages):
        try:
            for line in self.proc.stdout:
                try:
                    message = json.loads(line)
                except ValueError:
                    continue
                if isinstance(message, dict):
                    messages.put(message)
        finally:
            messages.put(None)

    def kill_tree(self, barrier):
        if self.proc.poll() is not None:
            raise RuntimeError('Peer exited before the tree stop')
        barrier.wait(timeout=10)
        begin = time.perf_counter_ns()
        if os.name == 'nt':
            subprocess.run(['taskkill', '/PID', str(self.proc.pid), '/T', '/F'],
                           capture_output=True, timeout=10, check=True)
        else:
            os.killpg(self.proc.pid, signal.SIGKILL)
        self.proc.wait(timeout=10)
        return begin, time.perf_counter_ns()

    def stop(self, result):
        result['exitAtObservation'] = self.proc.poll()
        try:
            self.proc.stdin.close()
        except OSError:
            pass
        try:
            result['exitAfterClose'] = self.proc.wait(timeout=4)
        except subprocess.TimeoutExpired:
            if os.name == 'nt':
                subprocess.run(['taskkill', '/PID', str(self.proc.pid), '/T', '/F'],
                               capture_output=True, timeout=8, check=True)
            else:
                self.proc.terminate()
            result['forcedStop'] = True
            result['exitAfterClose'] = self.proc.wait(timeout=8)
        self.reader.join(timeout=2)
        if self.reader.is_alive():
            raise RuntimeError('Native stdout stayed open after cleanup')
        self.proc.stdout.close()
        result['readinessExitMessage'] = 'standalone server exited before reporting readiness' in self.stderr.read_text(errors='replace').lower()


def utc():
    return datetime.now(timezone.utc).isoformat(timespec='milliseconds').replace('+00:00', 'Z')


def db_errors(data, start, end):
    path = data / 'opencode' / 'log' / 'opencode.log'
    if not path.is_file():
        return None
    with path.open('rb') as stream:
        stream.seek(max(0, path.stat().st_size - 131072))
        text = stream.read().decode(errors='replace')
    errors = []
    for line in text.splitlines():
        timestamp = line.removeprefix('timestamp=').split(' ', 1)[0]
        if start <= timestamp <= end and 'level=ERROR' in line:
            found = [term for term in ['configure database', 'disk i/o error', 'database is locked',
                                       'open database', 'unable to open database file'] if term in line.lower()]
            if found:
                errors.append({'time': timestamp, 'matched': found})
    return errors


def prepare(worker):
    warm = worker.start()
    worker.stop(warm)
    if warm['result'] != 'ready' or not (worker.data / 'opencode' / 'opencode.db').is_file():
        raise RuntimeError(f'Serial preparation failed: {warm}')


def compare(binary, root, rounds, layout):
    def workers_for(data):
        return [Worker(root / str(i), data[i], binary) for i in range(2)]

    stores = [root / (f'data-{i}' if layout == 'separate' else 'shared') for i in range(2)]
    workers = workers_for(stores)
    if layout != 'fresh':
        for worker in workers:
            prepare(worker)
    counts = Counter()
    failed_pairs = 0
    with ThreadPoolExecutor(max_workers=2) as pool:
        for number in range(1, rounds + 1):
            if layout == 'fresh':
                data = root / f'fresh-{number}'
                if data.exists():
                    raise RuntimeError('Fresh store already exists')
                workers = workers_for([data, data])
            barrier = threading.Barrier(2)
            timing = {}
            if layout == 'peer-stop':
                peer, incoming = workers
                first = peer.start()
                if first['result'] != 'ready':
                    peer.stop(first)
                    raise RuntimeError(f'Could not establish a live peer: {first}')
                start = utc()
                stop = pool.submit(peer.kill_tree, barrier)
                second = pool.submit(incoming.start, barrier).result()
                end = utc()
                stop_begin, stop_end = stop.result()
                timing = {'killStartRelativeToSpawnMs': (stop_begin - incoming.started) / 1e6,
                          'killEndRelativeToSpawnMs': (stop_end - incoming.started) / 1e6}
                peer.stop(first)
                incoming.stop(second)
                results = [second]
                timing['establishedPeer'] = first
            else:
                start = utc()
                opens = [pool.submit(w.start, barrier) for w in workers]
                results = [f.result() for f in opens]
                end = utc()
                cleanup = [pool.submit(w.stop, r) for w, r in zip(workers, results)]
                for future in cleanup:
                    future.result()
                timing['spawnSkewMs'] = abs(workers[0].started - workers[1].started) / 1e6
            failed_pairs += any(r['result'] != 'ready' for r in results)
            counts.update(r['result'] for r in results)
            print(json.dumps({'layout': layout, 'round': number, 'start': start, 'end': end,
                              **timing, 'opens': results, 'databaseLogs': [db_errors(d, start, end)
                              for d in dict.fromkeys(w.data for w in workers)]}), flush=True)
    print(json.dumps({'layout': layout, 'pairs': rounds, 'failedPairs': failed_pairs,
                      'processes': dict(counts)}), flush=True)


if __name__ == '__main__':
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--rounds', type=int, default=20)
    parser.add_argument('--bin', type=Path)
    parser.add_argument('--layouts', nargs='+', choices=['shared', 'separate', 'peer-stop', 'fresh'],
                        default=['shared', 'separate'])
    args = parser.parse_args()
    executable = (args.bin or Path(os.environ['OAR_CI_NPM_ROOT']) / '@opencode/cli/bin/opencode.exe').resolve(strict=True)
    with tempfile.TemporaryDirectory(prefix='opencode-pair-') as temp:
        root = Path(temp).resolve()
        env = Worker(root / 'identity', root / 'version', executable).env
        version = subprocess.check_output([executable, '--version'], env=env, cwd=root, timeout=15, text=True).strip()
        if version not in ('opencode v2.2.7', '2.2.7'):
            sys.exit('Expected OpenCode 2.2.7')
        print(json.dumps({'version': version, 'platform': sys.platform, 'roundsPerLayout': args.rounds}), flush=True)
        for layout in args.layouts:
            compare(executable, root / layout, args.rounds, layout)
