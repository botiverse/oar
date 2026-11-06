"""Select non-identifying native facts from the two local probe runs."""
import argparse
import hashlib
import json
import pathlib

parser = argparse.ArgumentParser(description=__doc__)
parser.add_argument('rc1', type=pathlib.Path, help='Complete 0.2.2-rc.1 probe output directory')
parser.add_argument('rc5', type=pathlib.Path, help='Complete 0.2.1-rc.5 probe output directory')
args = parser.parse_args()
result = []
for version, folder in [('0.2.2-rc.1', args.rc1), ('0.2.1-rc.5', args.rc5)]:
    for case in ['wake', 'kill', 'collected', 'quiet', 'budget', 'child', 'child-quiet', 'child-interrupt']:
        directory = folder.resolve() / case
        summary = json.loads((directory / 'summary.json').read_text())
        assert summary['version'] == version, summary['version']
        assert summary['kind'] == case, summary['kind']
        rows = [json.loads(line) for line in (directory / 'observer.jsonl').read_text().splitlines()]
        durable = json.loads((directory / 'durable.json').read_text())
        root = summary['root']
        observed = [r['data']['event'] for r in rows if r['kind'] == 'session-event' and r['data']['sessionId'] == root]
        assert all(event in durable for event in observed)
        def state(row):
            a = next((a for a in row.get('agents', []) if a['id'] == root), None)
            return None if a is None else {'status': a['status'], 'nextTurn': len(a['nextTurn']), 'nextStep': len(a['nextStep'])}
        notices = []
        settlements = []
        child_ends = []
        joins = []
        timeline = []
        latest_seq = None
        for index, row in enumerate(rows):
            d = row['data']
            if row['kind'] == 'session-event' and d['sessionId'] == root:
                e = d['event']; latest_seq = e['seq']; typ = e['type']
                if typ == 'job/settled':
                    settlements.append({'seq': e['seq'], 'status': e['data']['status'], 'cause': e['data']['cause'], 'producerReported': e['data']['producerReported'], 'keys': sorted(e['data']), 'inboxAtRecord': state(row)})
                    timeline.append({'seq': e['seq'], 'type': typ})
                elif typ == 'agent/inbox/spliced':
                    for msg in e['data']['inserted']:
                        if msg['source']['kind'] in ['tool-jobs', 'subagent-settled']:
                            n = {'seq': e['seq'], 'observerIndex': index, 'target': e['data']['target'], 'sourceKind': msg['source']['kind'], 'sourceKeys': sorted(msg['source']), 'inboxAtInsert': state(row)}
                            notices.append(n)
                            timeline.append({'seq': e['seq'], 'type': typ, 'target': n['target'], 'sourceKind': n['sourceKind']})
                elif typ in ['turn/start', 'turn/end']:
                    timeline.append({'seq': e['seq'], 'type': typ, 'turn': e['data']['turn']})
            if row['kind'] == 'subagent/end':
                earlier = [n['seq'] for n in notices if n['observerIndex'] < index]
                child_ends.append({'observerIndex': index, 'stopReason': d['stopReason'], 'noticeSeqsBeforeEnd': earlier, 'rootState': state(row)})
            if row['kind'] == 'whenIdle-resolved' and d['sessionId'] == root:
                joins.append({'afterType': d['afterType'], 'afterSeq': d['afterSeq'], 'rootLastSeqAtResolve': latest_seq, 'rootState': state(row)})
        checkpoints = []
        for s in summary['snapshots']:
            a = s['native']
            checkpoints.append({'label': s['label'], 'rootEnds': s['rootEnds'], 'rootRequests': s['requests'], 'native': {'status': a['status'], 'nextTurn': len(a['nextTurn']), 'nextStep': len(a['nextStep'])}})
        result.append({'version': version, 'case': case, 'config': summary['config'], 'checkpoints': checkpoints,
            'settlements': settlements, 'notices': notices, 'childEnds': child_ends, 'whenIdle': joins,
            'liveAwaitedFlags': [x['awaited'] for x in summary['liveSettles']], 'timeline': timeline,
            'allObservedRootEventsPersisted': True,
            'rawEvidence': {name: {'sha256': hashlib.sha256((directory / name).read_bytes()).hexdigest(), 'bytes': (directory / name).stat().st_size} for name in ['observer.jsonl', 'before-dispose.json', 'durable.json', 'summary.json']}})
print(json.dumps(result, indent=2))
