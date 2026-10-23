#!/usr/bin/env python3
"""Create reversible PC tiles with bit-exact indexed geometry and original photos.

No network, quantization, triangle removal, texture recompression or source writes.
Requires numpy and Pillow. Pass scene directory names, or omit for all ten scenes.
"""
import copy
import hashlib
import io
import json
from pathlib import Path
import struct
import sys

import numpy as np
from PIL import Image

ROOT = Path(__file__).resolve().parents[1]
MODELS = ROOT / 'public/models'
DEFAULT = [
    'world-helsinki-cathedral', 'world-helsinki-station',
    'world-helsinki-uspenski', 'world-helsinki-market-square',
    'world-helsinki-rock-church', 'world-helsinki-suomenlinna',
    'world-lyon-cityhall', 'world-melbourne-flinders',
    'world-melbourne-exhibition', 'world-melbourne-shrine',
]


def sha(data):
    return hashlib.sha256(data).hexdigest()


def save(path, data):
    path.write_text(json.dumps(data, ensure_ascii=False, indent=2) + '\n')


def parse_b3dm(raw):
    magic, version, size, *lengths = struct.unpack_from('<4s6I', raw)
    assert magic == b'b3dm' and version == 1 and size == len(raw)
    offset = 28 + sum(lengths)
    glb_magic, glb_version, glb_size = struct.unpack_from('<4sII', raw, offset)
    assert glb_magic == b'glTF' and glb_version == 2
    length, kind = struct.unpack_from('<II', raw, offset + 12)
    assert kind == 0x4e4f534a
    document = json.loads(raw[offset + 20:offset + 20 + length])
    start = offset + 20 + length
    bin_length, kind = struct.unpack_from('<II', raw, start)
    assert kind == 0x004e4942 and start + 8 + bin_length == offset + glb_size
    return document, raw[start + 8:start + 8 + bin_length], raw[:offset]


def read_accessor(document, binary, index):
    accessor = document['accessors'][index]
    view = document['bufferViews'][accessor['bufferView']]
    components = {'SCALAR': 1, 'VEC2': 2, 'VEC3': 3, 'VEC4': 4}[accessor['type']]
    dtype = {5121: 'u1', 5123: '<u2', 5125: '<u4', 5126: '<f4'}[accessor['componentType']]
    assert 'byteStride' not in view and 'sparse' not in accessor
    offset = view.get('byteOffset', 0) + accessor.get('byteOffset', 0)
    return np.frombuffer(binary, dtype=dtype, count=accessor['count'] * components,
                         offset=offset).reshape((-1, components))


def pack_b3dm(document, views, prefix):
    binary = bytearray()
    for view, data in zip(document['bufferViews'], views):
        binary.extend(b'\0' * (-len(binary) % 4))
        view['byteOffset'], view['byteLength'] = len(binary), len(data)
        binary.extend(data)
    binary.extend(b'\0' * (-len(binary) % 4))
    document['buffers'][0]['byteLength'] = len(binary)
    text = json.dumps(document, separators=(',', ':')).encode()
    text += b' ' * (-len(text) % 4)
    glb = struct.pack('<4sII', b'glTF', 2, 28 + len(text) + len(binary))
    glb += struct.pack('<II', len(text), 0x4e4f534a) + text
    glb += struct.pack('<II', len(binary), 0x004e4942) + binary
    header = bytearray(prefix)
    struct.pack_into('<I', header, 8, len(prefix) + len(glb))
    return bytes(header) + glb


def optimize(raw, photo=None):
    document, binary, prefix = parse_b3dm(raw)
    document = copy.deepcopy(document)
    assert len(document['meshes']) == 1 and len(document['meshes'][0]['primitives']) == 1
    primitive = document['meshes'][0]['primitives'][0]
    assert 'indices' not in primitive and primitive.get('mode', 4) == 4
    assert set(primitive['attributes']) == {'POSITION', 'TEXCOORD_0'}
    arrays = [read_accessor(document, binary, primitive['attributes'][key])
              for key in ['POSITION', 'TEXCOORD_0']]
    rows = np.concatenate([a.view('u1').reshape((len(a), -1)) for a in arrays], axis=1)
    _, first, inverse = np.unique(rows.view('V20').reshape(-1), return_index=True,
                                  return_inverse=True)
    assert np.array_equal(rows[first][inverse], rows)
    views = [binary[v.get('byteOffset', 0):v.get('byteOffset', 0) + v['byteLength']]
             for v in document['bufferViews']]
    for key, array in zip(['POSITION', 'TEXCOORD_0'], arrays):
        accessor = document['accessors'][primitive['attributes'][key]]
        accessor['count'] = len(first)
        views[accessor['bufferView']] = array[first].tobytes()
    indices = inverse.astype('<u2' if len(first) <= 65536 else '<u4')
    primitive['indices'] = len(document['accessors'])
    document['accessors'].append({'bufferView': len(views), 'componentType':
        5123 if indices.dtype.itemsize == 2 else 5125, 'count': len(indices), 'type': 'SCALAR'})
    document['bufferViews'].append({'buffer': 0, 'target': 34963})
    views.append(indices.tobytes())
    image = document['images'][0]
    assert len(document['images']) == 1 and image['mimeType'] == 'image/jpeg'
    original_photo = views[image['bufferView']]
    if photo is not None:
        views[image['bufferView']] = photo
    final_photo = views[image['bufferView']]
    with Image.open(io.BytesIO(final_photo)) as picture:
        dimensions = list(picture.size)
    result = pack_b3dm(document, views, prefix)
    # Audit the actual encoded output, rather than only the temporary arrays.
    check, data, _ = parse_b3dm(result)
    decoded = read_accessor(check, data, primitive['indices']).reshape(-1)
    expanded = np.concatenate([read_accessor(check, data, primitive['attributes'][key])
        [decoded].view('u1').reshape((len(decoded), -1)) for key in ['POSITION', 'TEXCOORD_0']], axis=1)
    assert expanded.tobytes() == rows.tobytes()
    return result, {'originalVertexCount': len(rows), 'indexedVertexCount': len(first),
        'triangles': len(rows) // 3, 'attributeTriangleSHA256': sha(rows.tobytes()),
        'originalPhotographSHA256': sha(original_photo), 'photographSHA256': sha(final_photo),
        'photographBytes': len(final_photo), 'photographDimensions': dimensions,
        'textureRGBABytes': dimensions[0] * dimensions[1] * 4}


def prepare(name):
    assert name in DEFAULT
    original, target = MODELS / name, MODELS / (name + '-pc')
    source = json.loads((original / 'source.json').read_text())
    target.mkdir(exist_ok=True)
    (target / 'tileset.json').write_bytes((original / 'tileset.json').read_bytes())
    records = []
    for record in source['files']:
        path = original / record['path']
        raw, photo = path.read_bytes(), None
        assert sha(raw) == record['sha256']
        if name.startswith('world-melbourne-'):
            filename = record['photograph']['source']
            block = filename.split('_L20_')[0]
            photo_path = ROOT / 'artifacts/landmark-scenes/originals/CoM_3D_Mesh_2018_OBJ/Data' / block / filename
            photo = photo_path.read_bytes()
            assert sha(photo) == record['photograph']['originalSHA256']
        output, audit = optimize(raw, photo)
        (target / record['path']).write_bytes(output)
        entry = copy.deepcopy(record)
        entry.update(audit, originalSHA256=sha(raw), originalBytes=len(raw),
                     bytes=len(output), sha256=sha(output))
        entry['photograph'].update(sha256=audit['photographSHA256'],
            bytes=audit['photographBytes'], dimensions=audit['photographDimensions'])
        records.append(entry)
    source.update(derivedFrom=f'../{name}/source.json', originalTileBytes=source['tileBytes'],
        conversion='Lossless byte-identical POSITION/TEXCOORD vertex deduplication with standard glTF indices; '
        'original ordered triangles, root transforms and bounds retained. Original JPEG bytes retained; '
        'Melbourne restores the original archive JPEG including 8K where available. No quantization, decimation, '
        'texture resampling or recompression. Original model directory remains unchanged.',
        files=records, tileBytes=sum(r['bytes'] for r in records),
        textureRGBABytes=sum(r['textureRGBABytes'] for r in records),
        textureMaxDimension=max(max(r['photographDimensions']) for r in records),
        textureResampling='none',
        photographHashMeaning='photograph.originalSHA256 identifies the archive JPEG; '
        'originalPhotographSHA256 identifies the JPEG embedded in the input B3DM. '
        'PC photograph.sha256 identifies the unchanged archive JPEG used for display.')
    save(target / 'source.json', source)
    summary = {'id': source['id'], 'pcUrl': f'models/{name}-pc/tileset.json',
        'originalTileBytes': source['originalTileBytes'], 'tileBytes': source['tileBytes'],
        'triangleCount': source['triangleCount'], 'textureRGBABytes': source['textureRGBABytes'],
        'originalVertexCount': sum(r['originalVertexCount'] for r in records),
        'indexedVertexCount': sum(r['indexedVertexCount'] for r in records)}
    print(json.dumps(summary), flush=True)
    return summary


if __name__ == '__main__':
    reports = [prepare(name) for name in (sys.argv[1:] or DEFAULT)]
    report_dir = ROOT / 'artifacts/scene-performance'
    report_dir.mkdir(exist_ok=True)
    save(report_dir / 'indexed-models.json', reports)
