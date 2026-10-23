#!/usr/bin/env python3
"""Prepare the two adjacent official CSDI sheets around Central's IFC waterfront.

Each sheet retains its source meshes, textures, ECEF transforms and source manifest.
The collection adds only an index referring to the two local sheet tilesets.
"""

import importlib.util
import json
import math
from pathlib import Path
import subprocess
import sys
import urllib.parse


PROJECT = Path(__file__).resolve().parents[1]
COMMON = PROJECT / 'scripts/prepare-hong-kong-scene.py'
DESTINATION = PROJECT / 'public/models/hong-kong-central'
SHEETS = [('11-SW-8B', [114.1561, 22.2874]),
          ('11-SW-9A', [114.1634, 22.2874])]


def main():
    spec = importlib.util.spec_from_file_location('hong_kong_source', COMMON)
    common = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(common)
    parts = []
    for sheet, center in SHEETS:
        destination = DESTINATION / sheet
        subprocess.run([
            sys.executable, str(COMMON), '--sheet', sheet,
            '--name', '香港·中环IFC海滨', '--center', *map(str, center),
            '--destination', str(destination.relative_to(PROJECT)), '--max-depth', '4',
        ], check=True)
        parts.append((sheet, json.loads((destination / 'source.json').read_text())))

    bounds = [min(p['bounds'][0] for _, p in parts),
              min(p['bounds'][1] for _, p in parts),
              max(p['bounds'][2] for _, p in parts),
              max(p['bounds'][3] for _, p in parts)]
    region = lambda extent: [math.radians(v) for v in extent] + [-100, 600]
    common.write_json(DESTINATION / 'tileset.json', {
        'asset': {'version': '1.0', 'gltfUpAxis': 'Z'}, 'geometricError': 600,
        'root': {
            'boundingVolume': {'region': region(bounds)}, 'geometricError': 600,
            'refine': 'REPLACE', 'children': [{
                'boundingVolume': {'region': region(p['bounds'])},
                'geometricError': 600, 'content': {'uri': f'{sheet}/tileset.json'},
            } for sheet, p in parts],
        },
    })
    source = {key: parts[0][1][key] for key in [
        'provider', 'attribution', 'ownership', 'processing', 'datasetId',
        'metadataUrl', 'licenseUrl', 'productUrl', 'revisionDateTimezone',
        'sourceHorizontalCRS', 'sourceVerticalDatum', 'tileCoordinateSystem', 'lodStrategy',
    ]}
    latest = max((p for _, p in parts), key=lambda p: p['sourceRevisionTimestamp'])
    source.update({
        'title': '香港·中环IFC海滨实景三维（双图幅）',
        'collection': True, 'sheet': ' + '.join(sheet for sheet, _ in parts),
        'sheets': [sheet for sheet, _ in parts], 'bounds': bounds,
        'center': [114.1595, 22.286],
        'recordQueryUrl': common.QUERY + '?' + urllib.parse.urlencode({
            'f': 'json', 'where': "SHEETNO IN ('11-SW-8B','11-SW-9A')",
            'outFields': '*', 'returnGeometry': 'true', 'outSR': '4326',
        }),
        'sourceRevisionDate': latest['sourceRevisionDate'],
        'sourceRevisionTimestamp': latest['sourceRevisionTimestamp'],
        'sourceRevisionDateMeaning': 'Latest official sheet revision; individual dates in sourceParts. Not imagery capture date.',
        'sourceParts': [{
            'directory': sheet, 'sourcePath': f'{sheet}/source.json',
            **{key: p[key] for key in [
                'sheet', 'bounds', 'center', 'recordQueryUrl', 'sourceRevisionDate',
                'sourceRevisionTimestamp', 'revisionDateTimezone', 'sourceZipBytes',
                'sourceRootCount', 'tileCount', 'tileBytes', 'lodStrategy',
            ]},
        } for sheet, p in parts],
        'roots': [{**record, 'path': f'{sheet}/{record["path"]}'}
                  for sheet, p in parts for record in p['roots']],
        'files': [{**record, 'path': f'{sheet}/{record["path"]}'}
                  for sheet, p in parts for record in p['files']],
        'coverageNote': 'Only adjacent source sheets 11-SW-8B and 11-SW-9A, not all of Hong Kong or all Central. Imagery capture dates are not independently published.',
    })
    for key in ['sourceZipBytes', 'sourceRootCount', 'tileCount', 'tileBytes']:
        source[key] = sum(p[key] for _, p in parts)
    if source['tileBytes'] > common.BUDGET:
        raise RuntimeError('Combined Central scene exceeds the 150 MiB model budget')
    source['totalBytes'] = 0
    for _ in range(4):
        common.write_json(DESTINATION / 'source.json', source)
        size = sum(p.stat().st_size for p in DESTINATION.rglob('*') if p.is_file())
        if source['totalBytes'] == size:
            break
        source['totalBytes'] = size
    print(f'Central collection ready: {source["tileCount"]} tiles, '
          f'{source["tileBytes"]:,} tile bytes; bounds {bounds}', flush=True)


if __name__ == '__main__':
    main()
