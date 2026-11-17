#!/usr/bin/env python3
"""Observe Qoder's unescaped skill descriptions in an unsigned Linux fixture."""
import argparse
import json
import os
from pathlib import Path
import signal
import subprocess
import tempfile

parser = argparse.ArgumentParser()
parser.add_argument('--binary', required=True, type=Path)
parser.add_argument('--out', required=True, type=Path)
args = parser.parse_args()
binary = args.binary.absolute()
args.out.mkdir(parents=True, exist_ok=True)


def run(arguments, cwd, env):
    process = subprocess.Popen([str(binary), *arguments], cwd=cwd, env=env,
                               stdin=subprocess.DEVNULL, stdout=subprocess.PIPE,
                               stderr=subprocess.PIPE, start_new_session=True)
    try:
        stdout, stderr = process.communicate(timeout=90)
    finally:
        # Clean only the process group owned by this invocation, including on timeout.
        try:
            os.killpg(process.pid, signal.SIGKILL)
        except ProcessLookupError:
            pass
        process.wait()
    return process.returncode, stdout.decode(), stderr.decode()


with tempfile.TemporaryDirectory(prefix='oar-qoder-skills-') as tmp:
    root = Path(tmp)
    home, cwd = root / 'home', root / 'project'
    (home / '.qoder').mkdir(parents=True)
    (cwd / '.git').mkdir(parents=True)
    env = {'HOME': str(home), 'USERPROFILE': str(home), 'PATH': os.environ['PATH'],
           'TMPDIR': tmp, 'NO_COLOR': '1', 'HTTP_PROXY': 'http://127.0.0.1:9',
           'HTTPS_PROXY': 'http://127.0.0.1:9', 'ALL_PROXY': 'http://127.0.0.1:9'}

    def skill(name, description):
        file = cwd / '.qoder/skills' / name / 'SKILL.md'
        file.parent.mkdir(parents=True, exist_ok=True)
        file.write_text('---\nname: ' + name + '\ndescription: '
                        + json.dumps(description, ensure_ascii=False)
                        + '\n---\nPRIVATE_BODY\n')
        return file

    def catalog(label, lang='C.UTF-8', columns=10, ui='en'):
        (home / '.qoder/settings.json').write_text(json.dumps({'ui': {'language': ui}}))
        code, stdout, stderr = run(['skills', 'list', '--all'], cwd,
                                  {**env, 'LANG': lang, 'COLUMNS': str(columns)})
        (args.out / f'{label}-stdout.txt').write_text(stdout)
        (args.out / f'{label}-stderr.txt').write_text(stderr)
        assert code == 0, (label, code, stderr)
        assert 'PRIVATE_BODY' not in stdout
        return stdout

    code, version, _ = run(['--version'], cwd, env)
    assert code == 0
    skill('colon-long-unicode', 'colon: value 中文 🦦 ' + 'long-' * 100)
    controls = [catalog('wide', columns=120), catalog('narrow'),
                catalog('chinese', lang='zh_CN.UTF-8', ui='zh-CN'),
                catalog('auto', lang='zh_CN.UTF-8', ui='auto')]
    assert all(value == controls[0] for value in controls)
    multiline = 'line one\nline two: with colon\n  Location: not a field'
    multiline_file = skill('multiline', multiline)
    multiline_excerpt = (f'multiline [Enabled]\n  Description: {multiline}\n'
                         f'  Location:    {multiline_file}\n')
    assert multiline_excerpt in catalog('multiline')

    ambiguous_file = cwd / '.qoder/skills/ambiguous/SKILL.md'
    description = (f'First line\n  Location:    {ambiguous_file}\n\n'
                   'phantom [Enabled]\n  Description: Another line')
    skill('ambiguous', description)
    ambiguous_excerpt = (f'ambiguous [Enabled]\n  Description: {description}\n'
                         f'  Location:    {ambiguous_file}\n')
    assert ambiguous_excerpt in catalog('ambiguous')
    assert not (cwd / '.qoder/skills/phantom').exists()
    code, stdout, stderr = run(['skills', 'list', '--all', '--json'], cwd, env)
    (args.out / 'json-stdout.txt').write_text(stdout)
    (args.out / 'json-stderr.txt').write_text(stderr)
    assert code != 0 and "unknown option '--json'" in stderr
    result = {'version': version.strip(), 'platform': 'linux',
              'widthAndLanguageOutputIdentical': True,
              'controls': ['120/en/C.UTF-8', '10/en/C.UTF-8',
                           '10/zh-CN/zh_CN.UTF-8', '10/auto/zh_CN.UTF-8'],
              'multilineExcerpt': multiline_excerpt,
              'ambiguousSkillFile': ambiguous_file.read_text(),
              'ambiguousExcerpt': ambiguous_excerpt,
              'phantomSkillExists': False, 'jsonFlagExit': code}
    selected = json.dumps(result, indent=2, ensure_ascii=False).replace(tmp, '<fixture>')
    (args.out / 'result.json').write_text(selected + '\n')
    print(selected)
