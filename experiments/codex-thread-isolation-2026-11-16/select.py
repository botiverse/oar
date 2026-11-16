"""Select cited native observations. All source markers are synthetic."""
import hashlib
import json
import pathlib
import sys

source = pathlib.Path(sys.argv[1])
data = json.loads(source.read_text())
assert data['platform'] == 'linux'
markers, tokens = data['markers'], data['tokens']
assert len(set(markers + tokens)) == 4
rows = []
for row in data['rows']:
    assert row['complete'], row.get('error')
    assert row['installation']['version'] == 'codex-cli 0.169.0'
    children = row['children']
    assert len(children) == 8
    assert len(row['turns']) == 6
    assert all(t['result']['status'] == 'completed' for t in row['turns'])
    hooks = row['hooks']['hooks']
    assert len(hooks) == 6
    selected_children = []
    for child in children:
        label = child.get('label') or ('A' if child['marker'] == markers[0] else 'B')
        index = 0 if label == 'A' else 1
        expected = row['mode'] == 'isolated-process' or child['kind'] in ('tool', 'background')
        assert child['marker'] == (markers[index] if expected else None)
        assert child['token'] == (tokens[index] if expected else None)
        selected = {k: child[k] for k in ('kind', 'marker', 'token')}
        selected['label'] = label
        if child['kind'] == 'tool':
            reads = child['processReads']
            expected_count = 3 if row['mode'] == 'shared-thread' else 4
            assert len(reads) == expected_count
            roles = ['app-server'] if expected_count == 3 else ['app-server-A', 'app-server-B']
            roles += ['background-A', 'background-B']
            selected['processReads'] = [dict(role=role, **{k: r[k] for k in ('readable', 'markers')}) for role, r in zip(roles, reads)]
            assert all(r['readable'] for r in reads)
            assert tokens[1-index] in reads[-(index+1)]['markers']
            files = child['fileReads']
            for category in ('sessions/', 'state_5.sqlite', 'logs_2.sqlite'):
                assert any(f['file'].startswith(category) and f['readable'] for f in files)
            selected['fileReads'] = {
                'rolloutsReadable': sum(f['readable'] for f in files if f['file'].startswith('sessions/')),
                'stateDatabaseReadable': any(f['file'] == 'state_5.sqlite' and f['readable'] for f in files),
                'logDatabaseReadable': any(f['file'] == 'logs_2.sqlite' and f['readable'] for f in files),
                'markerHits': [dict(category=f['file'].split('/')[0], markers=f['markers']) for f in files if f.get('markers')],
            }
        selected_children.append(selected)
    selected_hooks = []
    for hook in hooks:
        tool = hook['event']['tool_use_id']
        index = 0 if tool.startswith('tool-A_') else 1
        expected = row['mode'] == 'isolated-process'
        assert hook['marker'] == (markers[index] if expected else None)
        assert hook['token'] == (tokens[index] if expected else None)
        selected_hooks.append(dict(tool=tool, marker=hook['marker'], token=hook['token']))
    def storage(rows):
        return {'filesRead': len(rows), 'markerHits': [dict(category=f['file'].split('/')[0], markers=f['markers']) for f in rows if f['markers']],
                'rolloutsWithLiteralToken': sum(any(t in f['markers'] for t in tokens) for f in rows if f['file'].startswith('sessions/')),
                'sqliteFilesWithLiteralToken': sum(any(t in f['markers'] for t in tokens) for f in rows if '.sqlite' in f['file'])}
    rows.append(dict(mode=row['mode'], children=selected_children, hooks=selected_hooks,
                     beforePrompts=storage(row['beforePromptFiles']), afterPrompts=storage(row['afterPromptFiles'])))
assert [r['mode'] for r in rows] == ['shared-thread', 'isolated-thread', 'isolated-process']
print(json.dumps(dict(platform='linux', nativeVersion='codex-cli 0.169.0',
                     rawSha256=hashlib.sha256(source.read_bytes()).hexdigest(),
                     rawBytes=source.stat().st_size, markers=markers, tokens=tokens, rows=rows), indent=2))
