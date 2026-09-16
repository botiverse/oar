#!/usr/bin/env python3
"""Offline inventory: versions, generated Codex schemas and binary marker presence.
No servers, model requests, auth flows or user sessions are opened.
"""
from datetime import date
import hashlib
import json
import os
from pathlib import Path
import shutil
import subprocess
import tempfile

MARKERS = {
    'claude': ['control_cancel_request', 'cancel_queued', 'cancelQueued',
               'interrupt_cancel_queued_v1', 'interrupt_receipt_v1', 'msg_lifecycle_v1'],
    'grok': ['x.ai/queue/remove', 'x.ai/queue/clear', 'x.ai/queue/edit',
             'x.ai/queue/hold_edit', 'x.ai/queue/release_edit', 'x.ai/queue/reorder',
             'target_prompt_id', 'removedFromQueue', 'session/cancel'],
    'kimi': ['session/cancel', 'async cancel(params)', 'acpSession.cancel()',
             'this.agent.cancel({ turnId })', 'driver.cancelRequested = true'],
}

def run(*args):
    return subprocess.check_output(args, text=True, stderr=subprocess.PIPE, timeout=30).strip()

result = {'date': date.today().isoformat(), 'mode': 'offline-static; no behavioral guarantee from markers', 'runtimes': {}}
for name in ['codex', 'claude', 'grok', 'kimi']:
    executable = os.environ.get('OAR_' + name.upper() + '_BIN') or shutil.which(name)
    if not executable:
        result['runtimes'][name] = {'available': False}
        continue
    item = {'version': run(executable, '--version')}
    if name in MARKERS:
        data = Path(executable).read_bytes()
        item['sha256'] = hashlib.sha256(data).hexdigest()
        item['markers'] = {marker: data.find(marker.encode()) for marker in MARKERS[name]}
    else:
        with tempfile.TemporaryDirectory(prefix='oar-cancel-schema-') as directory:
            run(executable, 'app-server', 'generate-json-schema', '--experimental', '--out', directory)
            schemas = {}
            for stem in ['ThreadQueueAddResponse', 'ThreadQueueDeleteParams', 'ThreadQueueDeleteResponse', 'TurnSteerParams', 'TurnSteerResponse', 'TurnInterruptParams']:
                data = json.loads((Path(directory) / 'v2' / (stem + '.json')).read_text())
                schemas[stem] = {'required': data.get('required', []), 'properties': data.get('properties', {})}
            item['schemas'] = schemas
    result['runtimes'][name] = item
print(json.dumps(result, indent=2))
