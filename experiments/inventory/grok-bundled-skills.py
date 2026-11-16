"""Read only Grok's cached bundled skill metadata; no session or prompt.
Usage: python3 experiments/inventory/grok-bundled-skills.py /absolute/grok output.json
Other inspect fields and user/project skill entries are discarded in memory.
"""
import json
from pathlib import Path
import subprocess
import sys
import tempfile

binary, output = sys.argv[1:]
with tempfile.TemporaryDirectory(prefix='oar-grok-skills-') as cwd:
    version = subprocess.run([binary, '--version'], capture_output=True, text=True, check=True, timeout=15).stdout.strip()
    raw = subprocess.run([binary, 'inspect', '--json'], cwd=cwd, capture_output=True, text=True, check=True, timeout=30)
    skills = json.loads(raw.stdout)['skills']
    bundled = [
        {'name': s['name'], 'source': {'type': s['source']['type'], 'path': s['source']['path'].replace(str(Path.home()), '<home>')}}
        for s in skills if isinstance(s.get('source'), dict) and s['source'].get('type') == 'bundled'
    ]
    result = {'version': version, 'nativeSkillCount': len(skills), 'bundled': bundled}
    Path(output).write_text(json.dumps(result, indent=2) + '\n')
    print(json.dumps({'version': version, 'nativeSkillCount': len(skills), 'bundledCount': len(bundled)}))
