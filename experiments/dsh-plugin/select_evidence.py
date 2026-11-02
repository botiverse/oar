"""Select inspectable native frames and assertions, removing local absolute paths."""
import argparse
import hashlib
import json
from pathlib import Path
import re


def select(source):
    raw = source.read_bytes()
    data = json.loads(raw)
    root = str(source.parent)
    main = data['launches'][1]['frames']
    resumed = data['launches'][2]['frames']
    basic = [frame for frame in main if frame.get('sessionId') == 'oar-basic' and frame.get('type') == 'native']
    cwd = [frame for frame in main + resumed if frame.get('sessionId') == 'oar-cwd' and frame.get('event', {}).get('type') == 'tool/result']
    terminal = [frame for frame in main if frame.get('event', {}).get('type') == 'turn/end']
    child_id = data['child']['start']['info']['id']
    child_frames = [frame for frame in main if frame.get('sessionId') == child_id and frame.get('channel') == 'agent/assistant-stream']
    model = {key: value for key, value in data['modelCurrent'].items() if key != 'stack'}
    selected = {
        'version': data['version'], 'platform': data['platform'],
        'sourceSha256': hashlib.sha256(raw).hexdigest(),
        'selection': 'Native payloads retained; local absolute paths and encoded cwd directory keys replaced. Probe metadata is separate from native payloads.',
        'checks': data['checks'], 'loading': data['loading'], 'handshake': data['handshake'],
        'modelCurrent': model,
        'exits': [launch['exit'] for launch in data['launches']],
        'coldHomeChanges': data['coldHomeChanges'], 'warmHomeChanges': data['warmHomeChanges'],
        'profileChanges': data['profileChanges'], 'resumeCwd': data['resumeCwd'],
        'basicNativeFrames': basic, 'turnEnds': terminal, 'cwdToolResults': cwd,
        'child': data['child'], 'childStream': child_frames,
        'providerRequestCount': len(data['requests']),
        'userHomeMarkerObserved': any('OAR_USER_HOME_PATCH_MARKER' in json.dumps(request['messages']) for request in data['requests']),
    }

    def redact(value):
        if isinstance(value, str):
            value = value.replace(root, '$RUN')
            value = re.sub(r'/[^\s\"\']*/experiments/dsh-plugin/bridge', '$BRIDGE', value)
            return re.sub(r'^sessions/[^/]+/', 'sessions/$CWD_KEY/', value)
        if isinstance(value, list):
            return [redact(item) for item in value]
        if isinstance(value, dict):
            return {key: redact(item) for key, item in value.items()}
        return value

    return redact(selected)


if __name__ == '__main__':
    parser = argparse.ArgumentParser()
    parser.add_argument('source', type=Path)
    parser.add_argument('output', type=Path)
    args = parser.parse_args()
    args.output.parent.mkdir(parents=True, exist_ok=True)
    args.output.write_text(json.dumps(select(args.source.resolve()), indent=2) + '\n')
