"""Select cited synthetic frames. Keep complete raw captures outside the repository."""
import hashlib
import json
import pathlib
import sys

root = pathlib.Path(sys.argv[1])
out = pathlib.Path(sys.argv[2])
source = root / 'verified'
metadata = json.loads((source / 'metadata.json').read_text())

def read(name):
    return json.loads((source / f'{name}.json').read_text())

def frames(name, predicate):
    return [frame for frame in read(name)['frames'] if predicate(frame)]

def clean(value):
    if isinstance(value, dict):
        return {key: clean(item) for key, item in value.items()}
    if isinstance(value, list):
        return [clean(item) for item in value]
    if isinstance(value, str):
        return value.replace(metadata['root'], '<fixture>').replace(metadata['cli'], '<zcode-bundle>')
    return value

selected = {
    'version': '3.18.2 source build',
    'upstreamCommit': 'fec975905a2abd4c07e35c40d51fa097a2258ec9',
    'platform': 'linux x64',
    'node': metadata['node'],
    'redaction': 'Only selected native frames, synthetic input actions, and explicitly labelled request excerpts. Fixture paths replaced; full prompts and tool catalogues stay local.',
    'basic': frames('basic', lambda f: f['type'] in ('turn.started', 'result') or f.get('payload', {}).get('kind') in ('text_delta', 'reasoning_delta')),
    'tool': frames('tool', lambda f: f['type'] == 'tool.updated' and f['payload'].get('kind') in ('scheduled', 'result')),
    'resume': {
        'result': frames('resume', lambda f: f['type'] == 'result'),
        'requestMessageExcerpts': [m for m in read('resume')['requests'][0]['body']['messages'] if m.get('content') in ('OAR_PROBE_basic', 'LOCAL_DONE', 'OAR_PROBE_resume')],
    },
    'plan': frames('plan', lambda f: f['type'] in ('permission.resolved', 'result')),
    'planFileCreated': (pathlib.Path(metadata['cwd']) / 'PLAN_PROBE').exists(),
    'question': frames('question', lambda f: f['type'] in ('permission.requested', 'permission.resolved')),
    'mcp': {name: frames(name, lambda f: f['type'] == 'tool.updated' and f['payload'].get('kind') == 'result') for name in ('mcp_a', 'mcp_b')},
    'stdin': {'inputActions': read('stdin')['inputActions'], 'requestCount': len(read('stdin')['requests']), 'result': frames('stdin', lambda f: f['type'] == 'result')},
    'cancel': {'inputActions': read('cancel')['inputActions'], 'exit': read('cancel')['exit'], 'hasResult': any(f['type'] == 'result' for f in read('cancel')['frames']), 'frames': frames('cancel', lambda f: f['type'] == 'turn.completed')},
}
app = read('app')
app_events = [f for f in app['frames'] if f.get('method') == 'session/event']
selected['app'] = {
    'busyAndV4Responses': [r for r in app['outcomes'] if r.get('id') in ('7', '8')],
    'frames': [f for f in app_events if f['params']['type'] in ('turn.steerQueued', 'turn.steerDrained', 'turn.completed')],
    'createAndSendRequestExcerpts': [r for r in app['sent'] if r.get('method') in ('session/create', 'session/send', 'v4/command', 'session/stop')],
    'runtimePreferenceResponse': next(r for r in app['sent'] if r.get('id') == 'server-1' and 'result' in r),
    'twoSessionObservation': {
        'createdIds': [app['outcomes'][1]['result']['session']['sessionId'], app['outcomes'][-3]['result']['session']['sessionId']],
        'listedIds': [s['sessionId'] for s in app['outcomes'][-2]['result']['sessions']],
    },
    'steeredRequestMessageExcerpts': [m for r in app['requests'] for m in r['body']['messages'] if m.get('role') == 'user' and 'V4_GUIDE_MARKER' in json.dumps(m)],
}
out.mkdir(parents=True, exist_ok=True)
(out / 'evidence.json').write_text(json.dumps(clean(selected), indent=2) + '\n')
files = []
for p in sorted(root.rglob('*')):
    if p.is_file():
        files.append({'path': p.relative_to(root).as_posix(), 'bytes': p.stat().st_size, 'sha256': hashlib.sha256(p.read_bytes()).hexdigest()})
manifest = {
    'upstreamCommit': selected['upstreamCommit'],
    'sourceBuildSha256': hashlib.sha256(pathlib.Path(metadata['cli']).read_bytes()).hexdigest(),
    'localRawFiles': files,
    'authoritativeRun': 'verified',
    'earlierAttempts': {
        'first': 'Headless controls; plan case used an allowed read-only command.',
        'second': 'Write denial, question and MCP controls; app client omitted runtime preferences response.',
        'app-corrected': 'Create rejected because client omitted reasoning level.',
        'app-ready': 'Create succeeded; send omitted reasoning selection and emitted turn.failed.',
        'app-controls': 'Model/tool turns succeeded; probe waited for the wrong tool event type.',
        'app-controls-fixed': 'Complete app control passed.',
        'final': 'All native cases ran; probe incorrectly expected the global session list to contain only the two new app sessions.',
        'final-app': 'Corrected two-session identity assertion passed.',
        'verified': 'Final polished script, all ten scenarios and assertions passed.',
    },
}
(out / 'manifest.json').write_text(json.dumps(manifest, indent=2) + '\n')
