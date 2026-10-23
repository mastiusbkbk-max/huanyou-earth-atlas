#!/usr/bin/env python3
"""Prepare a compact, textured Hong Kong sheet from CSDI's public download.

Uses the download URL actively published in the official dataset record, never
Open3Dhk's streaming account key. HTTP Range avoids downloading the full ZIP.
Original B3DM files, textures, bounding volumes, and ECEF transforms are retained.
Only children below the selected depth are omitted; terminal geometricError becomes zero.
"""

import argparse
import concurrent.futures
import copy
from datetime import datetime, timezone, timedelta
import hashlib
import json
import math
from pathlib import Path, PurePosixPath
import struct
import subprocess
import threading
import urllib.parse
import urllib.request
import zipfile
import zlib


SHEET = '11-SW-4D'
DATASET = 'landsd_rcd_1671677054006_62261'
QUERY = f'https://portal.csdi.gov.hk/server/rest/services/common/{DATASET}/FeatureServer/0/query'
METADATA = f'https://portal.csdi.gov.hk/geoportal/rest/metadata/item/{DATASET}/xml'
LICENSE = 'https://portal.csdi.gov.hk/csdi-webpage/doc/TNC'
MAX_DEPTH = 5
BUDGET = 150 * 1024 * 1024
PROJECT = Path(__file__).resolve().parents[1]
CACHE = Path('/private/tmp/shanhe-hong-kong-source')


def curl(args, *, limit=10 * 1024 * 1024):
    result = subprocess.run(
        ['curl', '--silent', '--show-error', '--fail', '--retry', '2',
         '--max-time', '60', '--max-filesize', str(limit), *args],
        capture_output=True,
    )
    if result.returncode:
        # Do not include the published URL's download key in logs or artifacts.
        raise RuntimeError(f'Public download request failed (curl {result.returncode})')
    return result.stdout


class PublicArchive:
    def __init__(self, url):
        self.url = url
        headers = curl(['--head', url], limit=3 * 1024 * 1024 * 1024).decode()
        self.size = int(next(line.split(':', 1)[1] for line in headers.splitlines()
                             if line.lower().startswith('content-length:')))
        etag = next((line.split(':', 1)[1].strip() for line in headers.splitlines()
                     if line.lower().startswith('etag:')), str(self.size))
        self.cache = CACHE / hashlib.sha256(etag.encode()).hexdigest()[:16]
        self.cache.mkdir(parents=True, exist_ok=True)
        self.position = 0
        self.transfer_bytes = 0
        self.lock = threading.Lock()

    def range(self, start, end):
        end = min(end, self.size - 1)
        cache = self.cache / f'{start}-{end}.part'
        if cache.exists():
            return cache.read_bytes()
        for attempt in range(3):
            data = curl(['--range', f'{start}-{end}', '--header',
                         'Accept-Encoding: identity', self.url], limit=end - start + 1)
            if len(data) == end - start + 1:
                break
        else:
            raise RuntimeError(f'Server did not honor byte range {start}-{end}')
        cache.write_bytes(data)
        with self.lock:
            self.transfer_bytes += len(data)
        return data

    def seek(self, offset, whence=0):
        self.position = offset if whence == 0 else (
            self.position + offset if whence == 1 else self.size + offset)
        return self.position

    def tell(self):
        return self.position

    def seekable(self):
        return True

    def read(self, length=-1):
        if length < 0:
            length = self.size - self.position
        if length <= 0 or self.position >= self.size:
            return b''
        data = self.range(self.position, self.position + length - 1)
        self.position += len(data)
        return data

    def entry(self, item):
        # One request includes the local header and compressed entry. The padding
        # covers normal extra fields; ZIP's actual lengths are parsed below.
        data = self.range(item.header_offset, item.header_offset + 30 +
                          len(item.filename.encode('utf-8')) + 4096 + item.compress_size - 1)
        header = struct.unpack_from('<IHHHHHIIIHH', data)
        if header[0] != 0x04034B50:
            raise RuntimeError('Invalid ZIP local header')
        offset = 30 + header[9] + header[10]
        if offset + item.compress_size > len(data):
            data = self.range(item.header_offset,
                              item.header_offset + offset + item.compress_size - 1)
        payload = data[offset:offset + item.compress_size]
        if item.compress_type == zipfile.ZIP_DEFLATED:
            payload = zlib.decompress(payload, -15)
        elif item.compress_type != zipfile.ZIP_STORED:
            raise RuntimeError('Unsupported ZIP compression')
        if len(payload) != item.file_size or zlib.crc32(payload) != item.CRC:
            raise RuntimeError('ZIP entry checksum mismatch')
        return payload


def descendants(node, depth=0):
    yield node, depth
    for child in node.get('children', []):
        yield from descendants(child, depth + 1)


def prune(node, depth=0, max_depth=MAX_DEPTH):
    children = node.get('children', [])
    if depth >= max_depth and node.get('content'):
        node.pop('children', None)
        node['geometricError'] = 0
    else:
        for child in children:
            prune(child, depth + 1, max_depth)


def write_json(path, value):
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(json.dumps(value, ensure_ascii=False, separators=(',', ':')) + '\n')


def options():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--sheet', default=SHEET, help='Official CSDI sheet number')
    parser.add_argument('--name', default='香港·尖沙咀海滨', help='Scene name for source attribution')
    parser.add_argument('--center', nargs=2, type=float, metavar=('LONGITUDE', 'LATITUDE'),
                        default=[114.1706, 22.2933])
    parser.add_argument('--destination', default='hong-kong',
                        help='Model directory slug or project-relative public/models path')
    parser.add_argument('--max-depth', type=int, choices=range(1, MAX_DEPTH + 1), default=MAX_DEPTH,
                        help='Retained source tree depth; byte budget remains 150 MiB')
    args = parser.parse_args()
    requested = Path(args.destination)
    if requested.is_absolute() or '..' in requested.parts:
        parser.error('--destination must be a local model directory')
    if requested.parts[:2] == ('public', 'models'):
        destination = PROJECT / requested
    elif requested.parts[:1] == ('models',):
        destination = PROJECT / 'public' / requested
    else:
        destination = PROJECT / 'public/models' / requested
    models = (PROJECT / 'public/models').resolve()
    destination = destination.resolve()
    if destination == models or models not in destination.parents:
        parser.error('--destination must be below public/models')
    if args.sheet != SHEET and destination == models / 'hong-kong':
        parser.error('A new sheet requires its own --destination')
    source_path = destination / 'source.json'
    if source_path.exists() and json.loads(source_path.read_text())['sheet'] != args.sheet:
        parser.error('--destination already contains a different source sheet')
    return args, destination


def main():
    args, destination = options()
    query = urllib.parse.urlencode({
        'f': 'json', 'where': f"SHEETNO='{args.sheet}'", 'outFields': '*',
        'returnGeometry': 'true', 'outSR': '4326',
    })
    with urllib.request.urlopen(QUERY + '?' + query, timeout=30) as response:
        record = json.load(response)['features'][0]
    ring = record['geometry']['rings'][0]
    bounds = [min(p[0] for p in ring), min(p[1] for p in ring),
              max(p[0] for p in ring), max(p[1] for p in ring)]
    if not (bounds[0] < args.center[0] < bounds[2] and bounds[1] < args.center[1] < bounds[3]):
        raise RuntimeError('Scene center must be inside the official source sheet')
    archive = PublicArchive(record['attributes']['Format_3D_Tiles'])
    with zipfile.ZipFile(archive) as zipped:
        items = {item.filename: item for item in zipped.infolist() if not item.is_dir()}
    json_items = [item for item in items.values() if item.filename.endswith('/tileset.json')]
    print(f'{args.sheet}: source ZIP {archive.size:,} bytes, {len(json_items)} original roots', flush=True)

    def metadata(item):
        payload = archive.entry(item)
        original = json.loads(payload)
        compact = copy.deepcopy(original)
        prune(compact['root'], max_depth=args.max_depth)
        return item.filename, original, compact, hashlib.sha256(payload).hexdigest()

    with concurrent.futures.ThreadPoolExecutor(max_workers=8) as executor:
        tilesets = list(executor.map(metadata, json_items))

    needed = {}
    for name, original, compact, digest in tilesets:
        for node, depth in descendants(compact['root']):
            content = node.get('content', {})
            uri = content.get('uri', content.get('url'))
            if uri:
                path = str(PurePosixPath(name).parent / uri)
                if '..' in PurePosixPath(path).parts or path not in items:
                    raise RuntimeError('Unexpected content path')
                needed[path] = items[path]
    total = sum(item.file_size for item in needed.values())
    if total > BUDGET:
        raise RuntimeError(f'Selected LOD exceeds {BUDGET:,} byte budget: {total:,}')
    print(f'Depth {args.max_depth}: {len(needed)} textured tiles, {total:,} bytes', flush=True)

    def download(pair):
        name, item = pair
        path = destination / name
        if path.exists():
            data = path.read_bytes()
            if len(data) == item.file_size and zlib.crc32(data) == item.CRC:
                return name, len(data), hashlib.sha256(data).hexdigest()
        data = archive.entry(item)
        if data[:4] != b'b3dm':
            raise RuntimeError('Expected a B3DM tile')
        path.parent.mkdir(parents=True, exist_ok=True)
        path.write_bytes(data)
        return name, len(data), hashlib.sha256(data).hexdigest()

    files = []
    with concurrent.futures.ThreadPoolExecutor(max_workers=8) as executor:
        for count, result in enumerate(executor.map(download, needed.items()), 1):
            files.append({'path': result[0], 'bytes': result[1], 'sha256': result[2]})
            if count % 40 == 0 or count == len(needed):
                print(f'Validated {count}/{len(needed)} tiles', flush=True)

    children = []
    root_records = []
    for name, original, compact, digest in tilesets:
        write_json(destination / name, compact)
        root = original['root']
        transform = root['transform']
        sphere = root['boundingVolume']['sphere']
        # The source uses identity rotation plus ECEF translation. Keeping this
        # explicit prevents silently mishandling a future source coordinate change.
        if transform[:12] != [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0]:
            raise RuntimeError('Source ECEF rotation changed; inspect before rebuilding')
        world_sphere = [sphere[i] + transform[12 + i] for i in range(3)] + [sphere[3]]
        children.append({'boundingVolume': {'sphere': world_sphere},
                         'geometricError': original.get('geometricError', 600),
                         'content': {'uri': name}})
        root_records.append({'path': name, 'sourceSha256': digest,
                             'transform': transform, 'boundingVolume': root['boundingVolume']})
    root = {
        'asset': {'version': '1.0', 'gltfUpAxis': 'Z'}, 'geometricError': 600,
        'root': {
            'boundingVolume': {'region': [math.radians(v) for v in bounds] + [-100, 600]},
            'geometricError': 600, 'refine': 'REPLACE', 'children': children,
        },
    }
    write_json(destination / 'tileset.json', root)
    source = {
        'title': f'{args.name}实景三维（单网格）',
        'provider': '香港特别行政区政府地政总署 / CSDI Portal',
        'attribution': '© 香港特别行政区政府地政总署，资料来源：CSDI Portal',
        'ownership': '原始模型与纹理知识产权归香港特别行政区政府及相关机构所有。',
        'processing': '仅选取范围与LOD并调整加载索引，原B3DM字节未改。',
        'datasetId': DATASET, 'sheet': args.sheet, 'metadataUrl': METADATA,
        'recordQueryUrl': QUERY + '?' + query, 'licenseUrl': LICENSE,
        'productUrl': 'https://www.landsd.gov.hk/en/survey-mapping/mapping/3d-mapping.html',
        'sourceRevisionDate': datetime.fromtimestamp(
            record['attributes']['REVISIONDATE'] / 1000,
            timezone(timedelta(hours=8))).strftime('%Y-%m-%d'),
        'sourceRevisionTimestamp': record['attributes']['REVISIONDATE'],
        'revisionDateTimezone': 'Asia/Hong_Kong',
        'sourceZipBytes': archive.size, 'bounds': bounds,
        'center': args.center,
        'sourceHorizontalCRS': 'EPSG:2326', 'sourceVerticalDatum': 'Hong Kong Principal Datum',
        'tileCoordinateSystem': 'Original ECEF transforms and B3DM embedded mesh coordinates',
        'lodStrategy': {'maxTreeDepth': args.max_depth, 'allOriginalRootsRetained': True,
                        'deeperChildrenRemoved': True, 'terminalGeometricError': 0,
                        'meshesAndTexturesUnmodified': True},
        'sourceRootCount': len(tilesets), 'tileCount': len(files),
        'tileBytes': total, 'roots': root_records, 'files': files,
        'coverageNote': f'Only source sheet {args.sheet}, not all of Hong Kong or mainland cities.',
    }
    source['totalBytes'] = 0
    for attempt in range(4):
        write_json(destination / 'source.json', source)
        total_bytes = sum(p.stat().st_size for p in destination.rglob('*') if p.is_file())
        if source['totalBytes'] == total_bytes:
            break
        source['totalBytes'] = total_bytes
    print(f'Ready: {destination}/tileset.json; {len(files)} tiles; {total:,} tile bytes; '
          f'{archive.transfer_bytes:,} network bytes this run', flush=True)


if __name__ == '__main__':
    main()
