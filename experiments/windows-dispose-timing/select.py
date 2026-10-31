"""Select phase timings from the downloaded run artifacts; no private content."""
import json
import statistics
import sys
from pathlib import Path


def select(directory):
    rows = [json.loads(line) for line in (directory / 'timing.jsonl').read_text().splitlines()]
    roots, starts, queries, reads = {}, {}, {}, []
    for row in rows:
        stage = row['stage']
        if row.get('pid') is not None:
            roots.setdefault((row['round'], row['pid']), {}).setdefault(stage, []).append(row)
        if stage == 'query_command_start':
            queries[row['query']] = {'query': row['query'], 'round': row['round'],
                                     'start_at': row['at'], 'start_ms': row['monotonicMs']}
        if stage == 'query_command_end':
            queries[row['query']].update(end_at=row['at'], end_ms=row['monotonicMs'], ok=row['ok'])
        if stage == 'read_enqueued':
            starts[row['read']] = row
        if stage == 'read_returned':
            start = starts[row['read']]
            elapsed = row['monotonicMs'] - start['monotonicMs']
            reads.append({'read': row['read'], 'round': row['round'], 'start_ms': start['monotonicMs'],
                          'end_ms': row['monotonicMs'], 'elapsed_ms': elapsed,
                          'query_ms': row['queryMs'], 'waiting_and_wrapper_ms': elapsed - row['queryMs'],
                          'ok': row['ok'], 'reason': row.get('reason')})
    native = directory / 'powershell-stages.tsv'
    for line in native.read_text().splitlines():
        query, stage, at = line.split('\t')
        queries[int(query)][stage + '_at'] = int(at)
    stops = []
    for (round_id, pid), stages in roots.items():
        if 'stop_requested' not in stages:
            continue
        at = lambda stage: stages[stage][0]['monotonicMs'] if stage in stages else None
        span = lambda start, end: None if at(start) is None or at(end) is None else at(end) - at(start)
        capture = stages.get('capture_end', [{}])[0].get('diagnostic', {}).get('observations', [])
        capture_query = sum(item['elapsedMs'] for item in capture if item['phase'] == 'before_eof')
        stops.append({'round': round_id, 'pid': pid, 'stop_ms': at('stop_requested'),
                      'capture_ms': span('capture_start', 'capture_end'), 'capture_query_ms': capture_query,
                      'capture_waiting_and_wrapper_ms': None if at('capture_end') is None else span('capture_start', 'capture_end') - capture_query,
                      'eof_to_exit_ms': span('eof_requested', 'root_exit'),
                      'taskkill_to_exit_ms': span('taskkill_start', 'root_exit'),
                      'after_exit_ms': span('after_exit_start', 'after_exit_end'),
                      'total_ms': span('stop_requested', 'after_exit_end'),
                      'native_code': stages.get('root_exit', [{}])[0].get('code'),
                      'capture_observations': capture,
                      'final_diagnostic': stages.get('after_exit_end', [{}])[0].get('diagnostic')})
    completed = [s['total_ms'] for s in stops if s['total_ms'] is not None]
    query_list = list(queries.values())
    overlaps = [(a['query'], b['query']) for a, b in zip(query_list, query_list[1:])
                if a.get('end_ms') is not None and b['start_ms'] < a['end_ms']]
    preparation = directory / 'preparation.jsonl'
    return {'preparation': [json.loads(line) for line in preparation.read_text().splitlines()] if preparation.exists() else None,
            'summary': {'stops': len(stops), 'completed_stops': len(completed), 'reads': len(reads),
                        'queries': len(queries), 'overlapping_queries': overlaps,
                        'median_total_ms': statistics.median(completed), 'max_total_ms': max(completed),
                        'max_read_waiting_and_wrapper_ms': max(r['waiting_and_wrapper_ms'] for r in reads)},
            'stops': stops, 'reads': reads, 'queries': query_list}


if __name__ == '__main__':
    root = Path(sys.argv[1])
    result = {prepared: select(root / ('windows-dispose-prepared-' + prepared)) for prepared in ['false', 'true']}
    print(json.dumps(result, indent=2, sort_keys=True))
