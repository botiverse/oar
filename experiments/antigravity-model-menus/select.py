"""Keep only catalog fields and measurements cited by this report."""
import hashlib
import json
import pathlib
import sys

out = []
for arg in sys.argv[1:]:
    path = pathlib.Path(arg)
    raw = path.read_bytes()
    sample = json.loads(raw)
    assert sample['failure'] is None
    assert sample['providerRequests'] == 0
    results = sample['results']
    assert results['listingSettingsEqual'] is True
    opened = results['opened']
    option = next(o for o in opened['configOptions'] if o['id'] == 'model')
    expected_ids = {o['value'] for o in option['options']}
    assert expected_ids == {m['id'] for m in results['menus']}
    native_menus = []
    for row in results['menus']:
        thought = next(o for o in row['response']['configOptions'] if o.get('category') == 'thought_level')
        levels = [o['value'] for o in thought['options']]
        projected = next(m for m in results['oar']['models'] if m['id'] == row['id'])
        assert sorted(levels) == sorted(projected['effortLevels'])
        native_menus.append({'id': row['id'], 'levels': levels})
    out.append({'nativeVersion': results['version']['stdout'].strip(),
                'rawSha256': hashlib.sha256(raw).hexdigest(), 'rawBytes': len(raw),
                'availableModels': opened['models']['availableModels'],
                'currentModel': option['currentValue'], 'oarModels': results['oar']['models'],
                'perModelControl': native_menus,
                'listingElapsedMs': results['listingElapsedMs'],
                'settingsValuesUnchanged': results['listingSettingsEqual'],
                'providerRequests': sample['providerRequests'],
                'controlTimings': sample['timings']})
print(json.dumps(out, indent=2))
