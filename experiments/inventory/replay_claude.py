#!/usr/bin/env python3
"""Summarize Claude system/init events from an existing JSONL trace. No model call."""
import json
import sys

seen = set()


def visit(value):
    if isinstance(value, dict):
        if value.get('type') == 'system' and value.get('subtype') == 'init':
            summary = {
                'runtime': 'claude', 'surface': 'historical system/init replay',
                'version': value.get('claude_code_version'),
                'inventories': {
                    key: {'count': len(value.get(key, [])),
                          'itemTypes': sorted({type(item).__name__ for item in value.get(key, [])})}
                    for key in ('tools', 'skills', 'mcp_servers')
                },
            }
            encoded = json.dumps(summary, sort_keys=True)
            if encoded not in seen:
                print(encoded)
                seen.add(encoded)
        for child in value.values():
            visit(child)
    elif isinstance(value, list):
        for child in value:
            visit(child)


with open(sys.argv[1]) as source:
    for line in source:
        visit(json.loads(line))
if not seen:
    raise SystemExit('No Claude system/init object found')
