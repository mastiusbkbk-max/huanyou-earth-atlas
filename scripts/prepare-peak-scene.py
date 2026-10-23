#!/usr/bin/env python3
"""Extract two complete original Peak L16 meshes without re-encoding them.

This source uses legacy external JSON indexes and compressed Draco/KTX2 content.
Only the depth-three L16 model of root 8 and root 9 is downloaded. Each covers
its entire original root; repeated parent geometry is omitted. Native ECEF
spheres, node rotations, RTC centres, UVs, textures and model bytes are retained.
"""
import concurrent.futures
import copy
from datetime import datetime, timezone, timedelta
import hashlib
import importlib.util
import itertools
import json
import math
from pathlib import Path, PurePosixPath
import struct
import urllib.parse
import urllib.request
import zipfile
import zlib

PROJECT = Path(__file__).resolve().parents[1]
spec = importlib.util.spec_from_file_location('hong_kong_source', Path(__file__).with_name('prepare-hong-kong-scene.py'))
source = importlib.util.module_from_spec(spec)
spec.loader.exec_module(source)
original_curl = source.curl


def peak_curl(args, *, limit=10 * 1024 * 1024):
    # HEAD reads no model body; the official complete source is about 4.95 GB.
    return original_curl(['--retry-all-errors', *args],
                         limit=20 * 1024 ** 3 if '--head' in args else limit)


source.curl = peak_curl


class PeakArchive(source.PublicArchive):
    def range(self, start, end):
        end = min(end, self.size - 1)
        if end - start + 1 <= 2 * 1024 ** 2:
            return super().range(start, end)
        ranges = [(pos, min(pos + 2 * 1024 ** 2 - 1, end))
                  for pos in range(start, end + 1, 2 * 1024 ** 2)]
        def part(pair):
            return super(PeakArchive, self).range(*pair)
        with concurrent.futures.ThreadPoolExecutor(max_workers=4) as executor:
            return b''.join(executor.map(part, ranges))


SHEET = '11-SW-13C'
SELECTED = ['11-SW-13C-8', '11-SW-13C-9']
SOURCE_DEPTH = 3
DESTINATION = PROJECT / 'public/models/hong-kong-peak'
EVIDENCE = PROJECT / 'artifacts/real-scene/peak-source-indexes'


def write_json(path, value):
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(json.dumps(value, ensure_ascii=False, separators=(',', ':')) + '\n')


def sha(data):
    return hashlib.sha256(data).hexdigest()


def resolve_content(document, uri):
    path = PurePosixPath(document).parent / uri
    if '..' in path.parts or path.is_absolute():
        raise RuntimeError('Unexpected source content path')
    return str(path)


def geodetic(point):
    x, y, z = point
    a, e2 = 6378137., 0.0066943799901413165
    longitude = math.atan2(y, x)
    rho = math.hypot(x, y)
    latitude = math.atan2(z, rho * (1 - e2))
    for ignored in range(8):
        n = a / math.sqrt(1 - e2 * math.sin(latitude) ** 2)
        height = rho / math.cos(latitude) - n
        latitude = math.atan2(z, rho * (1 - e2 * n / (n + height)))
    return [math.degrees(longitude), math.degrees(latitude), height]


def multiply(a, b):
    return [sum(a[k * 4 + row] * b[col * 4 + k] for k in range(4))
            for col in range(4) for row in range(4)]


def validate_model(data):
    if data[:4] != b'b3dm' or struct.unpack_from('<I', data, 4)[0] != 1:
        raise RuntimeError('Expected B3DM version 1')
    if struct.unpack_from('<I', data, 8)[0] != len(data):
        raise RuntimeError('Invalid B3DM length')
    table_sizes = struct.unpack_from('<4I', data, 12)
    feature = json.loads(data[28:28 + table_sizes[0]].rstrip(b'\x00 '))
    rtc = feature.get('RTC_CENTER')
    if not isinstance(rtc, list) or len(rtc) != 3:
        raise RuntimeError('Expected original ECEF RTC_CENTER')
    glb = 28 + sum(table_sizes)
    magic, version, length = struct.unpack_from('<4sII', data, glb)
    if magic != b'glTF' or version != 2 or glb + length > len(data):
        raise RuntimeError('Expected a complete embedded GLB version 2')
    json_length, json_type = struct.unpack_from('<II', data, glb + 12)
    if json_type != 0x4e4f534a:
        raise RuntimeError('Missing GLB JSON chunk')
    model = json.loads(data[glb + 20:glb + 20 + json_length].rstrip(b'\x00 '))
    binary_header = glb + 20 + json_length
    binary_length, binary_type = struct.unpack_from('<II', data, binary_header)
    if binary_type != 0x004e4942 or binary_header + 8 + binary_length > len(data):
        raise RuntimeError('Missing embedded GLB binary data')
    binary_start = binary_header + 8
    if any(buffer.get('uri') for buffer in model.get('buffers', [])):
        raise RuntimeError('Unexpected external GLB buffer')
    if not model.get('images') or not model.get('textures') or not model.get('meshes'):
        raise RuntimeError('Missing embedded mesh or photography')
    images = []
    for image in model['images']:
        if image.get('uri') or image.get('mimeType') != 'image/ktx2':
            raise RuntimeError('Unexpected external or non-KTX2 source texture')
        view = model['bufferViews'][image['bufferView']]
        offset = binary_start + view.get('byteOffset', 0)
        if offset + view['byteLength'] > binary_start + binary_length:
            raise RuntimeError('Embedded texture is truncated')
        if data[offset:offset + 12] != b'\xabKTX 20\xbb\r\n\x1a\n':
            raise RuntimeError('Invalid embedded KTX2 signature')
        images.append({'mimeType': image['mimeType'], 'bytes': view['byteLength'],
                       'width': struct.unpack_from('<I', data, offset + 20)[0],
                       'height': struct.unpack_from('<I', data, offset + 24)[0]})
    positions = []
    identity = [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1]
    def node_points(index, parent):
        node = model['nodes'][index]
        if any(key in node for key in ['translation', 'rotation', 'scale']):
            raise RuntimeError('Unexpected source TRS transform; inspect before preparing')
        matrix = multiply(parent, node.get('matrix', identity))
        if 'mesh' in node:
            for primitive in model['meshes'][node['mesh']]['primitives']:
                accessor = model['accessors'][primitive['attributes']['POSITION']]
                if accessor.get('type') != 'VEC3' or 'min' not in accessor or 'max' not in accessor:
                    raise RuntimeError('Expected original POSITION bounds')
                if not primitive.get('extensions', {}).get('KHR_draco_mesh_compression'):
                    raise RuntimeError('Expected original Draco mesh data')
                for point in itertools.product(*zip(accessor['min'], accessor['max'])):
                    world = [rtc[row] + matrix[12 + row] +
                             sum(matrix[k * 4 + row] * point[k] for k in range(3))
                             for row in range(3)]
                    positions.append(geodetic(world))
        for child in node.get('children', []):
            node_points(child, matrix)
    for index in model['scenes'][model.get('scene', 0)]['nodes']:
        node_points(index, identity)
    return {'rtcCenter': rtc, 'images': images,
            'bounds': [min(p[0] for p in positions), min(p[1] for p in positions),
                       max(p[0] for p in positions), max(p[1] for p in positions)],
            'ellipsoidHeightRange': [min(p[2] for p in positions), max(p[2] for p in positions)],
            'primitiveCount': sum(len(mesh['primitives']) for mesh in model['meshes'])}


def main():
    query = urllib.parse.urlencode({'f': 'json', 'where': f"SHEETNO='{SHEET}'",
                                   'outFields': '*', 'returnGeometry': 'true', 'outSR': '4326'})
    for attempt in range(3):
        try:
            with urllib.request.urlopen(source.QUERY + '?' + query, timeout=40) as response:
                record = json.load(response)['features'][0]
            break
        except Exception:
            if attempt == 2:
                raise RuntimeError('Official source record request failed') from None
    ring = record['geometry']['rings'][0]
    sheet_bounds = [min(p[0] for p in ring), min(p[1] for p in ring),
                    max(p[0] for p in ring), max(p[1] for p in ring)]
    archive = PeakArchive(record['attributes']['Format_3D_Tiles'])
    with zipfile.ZipFile(archive) as zipped:
        entries = {item.filename: item for item in zipped.infolist() if not item.is_dir()}
    originals, documents, needed, index_files = {}, {}, {}, []
    def read_index(path):
        data = archive.entry(entries[path])
        original = json.loads(data)
        EVIDENCE.joinpath(path).parent.mkdir(parents=True, exist_ok=True)
        EVIDENCE.joinpath(path).write_bytes(data)
        originals[path] = (original, sha(data))
        return original
    top_original = read_index('tileset.json')
    base_paths = sorted(path for path in entries if path.endswith('.json') and
                        PurePosixPath(path).parent.name in SELECTED and '_L' not in path)
    if len(base_paths) != 2:
        raise RuntimeError('Expected two selected native mesh roots')
    def retain_leaf(path):
        original = read_index(path)
        compact = copy.deepcopy(original)
        root = compact['root']
        if root.get('transform') is not None:
            raise RuntimeError('Legacy source coordinate encoding changed')
        selected_path, selected = path, original
        for depth in range(SOURCE_DEPTH):
            children = selected['root'].get('children', [])
            if len(children) != 1 or children[0].get('children'):
                raise RuntimeError('Expected one complete-coverage external child')
            child_uri = children[0].get('content', {}).get('uri')
            if not child_uri or not child_uri.endswith('.json'):
                raise RuntimeError('Expected external JSON child')
            selected_path = resolve_content(selected_path, child_uri)
            selected = read_index(selected_path)
        uri = selected['root'].get('content', {}).get('uri')
        if not uri or not uri.endswith('.b3dm'):
            raise RuntimeError('Expected one original L16 model')
        model_path = resolve_content(selected_path, uri)
        if not model_path.endswith('_L16_000.b3dm') or PurePosixPath(model_path).parent != PurePosixPath(path).parent:
            raise RuntimeError('Unexpected complete-coverage L16 path')
        needed[model_path] = entries[model_path]
        root['content'] = {'uri': PurePosixPath(model_path).name}
        root.pop('children', None)
        root['geometricError'] = 0
        compact['geometricError'] = 0
        documents[path] = compact
        index_files.append({'path': path, 'sourceSha256': originals[path][1],
                            'retainedDepth': 0, 'selectedSourceDepth': SOURCE_DEPTH,
                            'sourceContentPath': selected_path,
                            'sourceContentSha256': originals[selected_path][1]})
    for path in base_paths:
        retain_leaf(path)
    total = sum(item.file_size for item in needed.values())
    if total > source.BUDGET:
        raise RuntimeError('Selected original models exceed 150 MiB budget')
    print(f'Peak original depth {SOURCE_DEPTH}: {len(needed)} complete L16 tiles; {total:,} bytes', flush=True)
    def download(pair):
        path, item = pair
        target = DESTINATION / path
        data = target.read_bytes() if target.exists() else b''
        if len(data) != item.file_size or zlib.crc32(data) != item.CRC:
            data = archive.entry(item)
        details = validate_model(data)
        target.parent.mkdir(parents=True, exist_ok=True)
        target.write_bytes(data)
        print(f'Validated {path}: {len(data):,} bytes', flush=True)
        return {'path': path, 'bytes': len(data), 'sha256': sha(data),
                'sourceDepth': SOURCE_DEPTH, **details}
    with concurrent.futures.ThreadPoolExecutor(max_workers=2) as executor:
        files = list(executor.map(download, sorted(needed.items())))
    bounds = [min(f['bounds'][0] for f in files), min(f['bounds'][1] for f in files),
              max(f['bounds'][2] for f in files), max(f['bounds'][3] for f in files)]
    heights = [min(f['ellipsoidHeightRange'][0] for f in files),
               max(f['ellipsoidHeightRange'][1] for f in files)]
    for item in index_files:
        write_json(DESTINATION / item['path'], documents[item['path']])
        item['localSha256'] = sha((DESTINATION / item['path']).read_bytes())
    children = []
    root_records = []
    for path in base_paths:
        original, digest = originals[path]
        children.append({'boundingVolume': original['root']['boundingVolume'],
                         'geometricError': 0,
                         'content': {'uri': path}, 'refine': 'REPLACE'})
        root_records.append({'path': path, 'sourceSha256': digest,
                             'boundingVolume': original['root']['boundingVolume']})
    top = {'asset': {'version': '1.0', 'gltfUpAxis': 'Z'}, 'geometricError': 480,
           'root': {'boundingVolume': {'region': [math.radians(v) for v in bounds] + heights},
                    'geometricError': 480, 'refine': 'REPLACE', 'children': children}}
    write_json(DESTINATION / 'tileset.json', top)
    revision = record['attributes']['REVISIONDATE']
    manifest = {
        'title': '香港 · 太平山凌霄阁实景三维（局部网格）',
        'provider': '香港特别行政区政府地政总署 / CSDI Portal',
        'attribution': '© 香港特别行政区政府地政总署，资料来源：CSDI Portal',
        'ownership': '原始模型与纹理知识产权归香港特别行政区政府及相关机构所有。',
        'processing': '仅选取原生root 8、9在原深度3的完整覆盖L16模型，保留原root包围体，加载索引直接指向对应原生叶模型，省略重复父级几何；原B3DM字节、UV、法线和纹理均未改动或重编码。',
        'datasetId': source.DATASET, 'sheet': SHEET, 'metadataUrl': source.METADATA,
        'recordQueryUrl': source.QUERY + '?' + query, 'licenseUrl': source.LICENSE,
        'productUrl': 'https://www.landsd.gov.hk/en/survey-mapping/mapping/3d-mapping.html',
        'sourceRevisionDate': datetime.fromtimestamp(revision / 1000, timezone(timedelta(hours=8))).strftime('%Y-%m-%d'),
        'sourceRevisionTimestamp': revision, 'revisionDateTimezone': 'Asia/Hong_Kong',
        'sourceZipBytes': archive.size, 'sourceSheetBounds': sheet_bounds, 'bounds': bounds,
        'boundsApproximate': True,
        'boundsMethod': 'Conservative WGS84 envelope of the original POSITION accessor min/max corners after original glTF node matrices and feature RTC_CENTER. This is the original mesh grid extent, not an administrative boundary or the full source sheet.',
        'ellipsoidHeightRange': heights, 'center': [114.14985, 22.2716],
        'sourceHorizontalCRS': 'EPSG:2326', 'sourceVerticalDatum': 'Hong Kong Principal Datum',
        'tileCoordinateSystem': 'Original world ECEF spheres and B3DM feature RTC_CENTER plus original glTF ENU-to-ECEF node matrices; no tileset transform was added.',
        'sourceAssetVersion': '0.0', 'generatedRootAssetVersion': '1.0',
        'sourceRootCount': 2, 'originalSourceRootCount': len(top_original['root']['children']),
        'selectedSourceRoots': SELECTED,
        'lodStrategy': {'maxTreeDepth': 0, 'selectedSourceDepth': SOURCE_DEPTH,
                        'allOriginalRootsRetained': False,
                        'deeperChildrenRemoved': True, 'terminalGeometricError': 0,
                        'meshesAndTexturesUnmodified': True, 'externalIndexTreeRetained': False,
                        'sourceRootBoundsRetained': True,
                        'coverageVerification': 'All four original levels have identical decoded POSITION multisets and oriented triangle geometry after canonical ordering. The selected L16 retains its own original UVs, normals and higher-resolution photography.'},
        'tileCount': len(files), 'tileBytes': total, 'roots': root_records,
        'indexFiles': index_files, 'files': files,
        'coverageNote': 'Only 2 of 20 original roots (subroots 8 and 9) near Peak Tower, not the full source sheet, not all of Hong Kong or mainland cities.',
        'totalBytes': 0,
    }
    for attempt in range(5):
        write_json(DESTINATION / 'source.json', manifest)
        size = sum(path.stat().st_size for path in DESTINATION.rglob('*') if path.is_file())
        if size == manifest['totalBytes']:
            break
        manifest['totalBytes'] = size
    if size > source.BUDGET:
        raise RuntimeError('Prepared files exceed 150 MiB total budget')
    print(json.dumps({'ready': str(DESTINATION), 'bounds': bounds, 'ellipsoidHeightRange': heights,
                      'tileBytes': total, 'totalBytes': size, 'networkBytes': archive.transfer_bytes}), flush=True)


if __name__ == '__main__':
    main()
