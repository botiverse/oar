"""Rebuild compact synthetic child environment evidence, retaining every observed execution."""
import json
import pathlib
import sys


def select(row, kind):
    required = ('runtime', 'version', 'platform', 'arch', 'placement', 'errors', 'processHome', 'sessionCwds')
    if any(key not in row for key in required):
        raise ValueError('Missing child environment observation field')
    cwds = row['sessionCwds']
    if len(cwds) != 2:
        raise ValueError('Expected two session directories')
    def location(value):
        if value in cwds:
            return 'session_' + 'AB'[cwds.index(value)]
        return 'process_HOME' if value == row['processHome'] else value
    selected = {key: row[key] for key in required[:6]}
    selected['kind'] = kind
    if 'tools' in row:
        selected['tools'] = [dict(label=s['label'], cwd=location(s['cwd']),
                                  environmentMarker=s['environmentMarker']) for s in row['tools']]
    if kind == 'mcp':
        observations = row.get('observations')
        if not observations or not row.get('tools') or 'sessionDirectoriesObserved' not in row:
            raise ValueError('Missing MCP or tool child executions')
        selected.update(source=row['source'], sessionDirectoriesObserved=row['sessionDirectoriesObserved'],
                        calls=row['calls'], observations=[dict(server=s['server'], cwd=location(s['cwd']),
                        environmentMarker=s['environmentMarker'], matchesSession=s['matchesSession']) for s in observations])
    else:
        hooks = row.get('evidence', {}).get('hooks')
        if not hooks:
            raise ValueError('Missing actual hook invocations')
        selected['scope'] = row['scope']
        selected['hooks'] = []
        for hook in hooks:
            value = dict(revision=hook['revision'], cwd=location(hook['cwd']), environmentMarker=hook['environmentMarker'])
            if 'child' in hook:
                value.update(location=location(hook['location']), childCwd=location(hook['child']['cwd']),
                             childEnvironmentMarker=hook['child']['environmentMarker'])
            selected['hooks'].append(value)
    return selected


if __name__ == '__main__':
    root = pathlib.Path(sys.argv[1])
    rows = []
    for runtime, version in [('opencode', '2.2.3'), ('opencode', '2.2.5'), ('grok', '1.0.70')]:
        directory = root / f'execution-environment-{runtime}-{version}'
        for kind, scopes in [('mcp', ['session', 'user']), ('hooks', ['user', 'project'])]:
            for scope in scopes:
                for placement in ['shared', 'isolated']:
                    row = json.loads((directory / f'{kind}-{scope}-{placement}.json').read_text())
                    rows.append(select(row, kind))
    print(json.dumps(rows, indent=2) + '\n', end='')
