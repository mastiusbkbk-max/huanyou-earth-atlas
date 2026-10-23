#!/usr/bin/env python3
"""Prepare locally hosted, attributed public city meshes without changing photos.

Requires numpy, requests, Pillow and pyproj. Downloads ZIP members
with HTTP Range requests, rather than downloading multi-gigabyte city archives.
"""
import binascii
import concurrent.futures
import hashlib
import io
import json
import math
import os
from pathlib import Path
import re
import struct
import sys
import zipfile
import zlib

import numpy as np
import requests

ROOT = Path(__file__).resolve().parents[1]
ARTIFACTS = ROOT / 'artifacts/world-scenes'
ARTIFACTS.mkdir(parents=True, exist_ok=True)


def sha(data):
    return hashlib.sha256(data).hexdigest()


class RangeZip:
    def __init__(self, url, suffix=8_000_000):
        self.url = url
        response = requests.get(url, headers={'Range': f'bytes=-{suffix}'}, timeout=90)
        response.raise_for_status()
        if response.status_code != 206:
            raise ValueError('Source must support HTTP Range')
        self.length = int(response.headers['Content-Range'].split('/')[-1])
        self.start = self.length - len(response.content)
        self.archive = zipfile.ZipFile(io.BytesIO(response.content))
        self.files = {entry.filename: entry for entry in self.archive.infolist()}

    def read(self, name):
        entry = self.files[name]
        start = self.start + entry.header_offset
        end = start + 30 + len(name.encode()) + len(entry.extra) + entry.compress_size + 1024
        response = requests.get(self.url, headers={'Range': f'bytes={start}-{end}'}, timeout=90)
        response.raise_for_status()
        if response.status_code != 206:
            raise ValueError('Expected a partial ZIP member')
        payload = response.content
        header = struct.unpack_from('<I5H3I2H', payload)
        if header[0] != 0x04034b50:
            raise ValueError('Bad ZIP local header')
        compressed = payload[30 + header[-2] + header[-1]:][:entry.compress_size]
        data = zlib.decompress(compressed, -15) if entry.compress_type == 8 else compressed
        if len(data) != entry.file_size or binascii.crc32(data) & 0xffffffff != entry.CRC:
            raise ValueError(f'ZIP CRC mismatch: {name}')
        return data

    def read_group(self, names):
        entries = [self.files[name] for name in names]
        first = min(self.start + entry.header_offset for entry in entries)
        last = max(self.start + entry.header_offset + 30 + len(entry.filename.encode()) + len(entry.extra) + entry.compress_size + 1024 for entry in entries)
        response = requests.get(self.url, headers={'Range': f'bytes={first}-{last}'}, timeout=180)
        response.raise_for_status()
        if response.status_code != 206:
            raise ValueError('Expected a partial ZIP group')
        result = {}
        for entry in entries:
            offset = self.start + entry.header_offset - first
            header = struct.unpack_from('<I5H3I2H', response.content, offset)
            start = offset + 30 + header[-2] + header[-1]
            compressed = response.content[start:start + entry.compress_size]
            data = zlib.decompress(compressed, -15) if entry.compress_type == 8 else compressed
            if len(data) != entry.file_size or binascii.crc32(data) & 0xffffffff != entry.CRC:
                raise ValueError(f'ZIP CRC mismatch: {entry.filename}')
            result[entry.filename] = data
        return result


def write_json(path, value):
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(json.dumps(value, ensure_ascii=False, separators=(',', ':')) + '\n')


def local_frame(lon, lat):
    from pyproj import Transformer
    longitude, latitude = math.radians(lon), math.radians(lat)
    east = [-math.sin(longitude), math.cos(longitude), 0]
    north = [-math.sin(latitude) * math.cos(longitude), -math.sin(latitude) * math.sin(longitude), math.cos(latitude)]
    up = [math.cos(latitude) * math.cos(longitude), math.cos(latitude) * math.sin(longitude), math.sin(latitude)]
    rotation = np.array([east, north, up], dtype=np.float64).T
    origin = np.array(Transformer.from_crs(4979, 4978, always_xy=True).transform(lon, lat, 0))
    matrix = np.eye(4)
    matrix[:3, :3] = rotation
    matrix[:3, 3] = origin
    return origin, rotation, matrix.T.flatten().tolist()


def make_b3dm(positions, uv, texture, texture_name, flip_v=True):
    # glTF is Y-up. Its normal Y-to-Z conversion yields [East, North, Up].
    gltf_positions = positions[:, [0, 2, 1]].copy()
    gltf_positions[:, 2] *= -1
    gltf_uv = uv.copy()
    if flip_v:
        gltf_uv[:, 1] = 1 - gltf_uv[:, 1]
    data = bytearray()
    views = []
    for blob in [gltf_positions.astype('<f4').tobytes(), gltf_uv.astype('<f4').tobytes(), texture]:
        data.extend(b'\0' * (-len(data) % 4))
        views.append({'buffer': 0, 'byteOffset': len(data), 'byteLength': len(blob)})
        data.extend(blob)
    gltf = {
        'asset': {'version': '2.0', 'generator': 'Shanhe public-mesh format conversion; no geometry simplification'},
        'scene': 0, 'scenes': [{'nodes': [0]}], 'nodes': [{'mesh': 0}],
        'meshes': [{'primitives': [{'attributes': {'POSITION': 0, 'TEXCOORD_0': 1}, 'material': 0, 'mode': 4}]}],
        'materials': [{'name': texture_name, 'doubleSided': True, 'pbrMetallicRoughness': {'baseColorTexture': {'index': 0}, 'metallicFactor': 0, 'roughnessFactor': 1}}],
        'textures': [{'source': 0, 'sampler': 0}],
        'samplers': [{'magFilter': 9729, 'minFilter': 9729, 'wrapS': 33071, 'wrapT': 33071}],
        'images': [{'bufferView': 2, 'mimeType': 'image/jpeg', 'name': texture_name}],
        'accessors': [
            {'bufferView': 0, 'componentType': 5126, 'count': len(positions), 'type': 'VEC3', 'min': gltf_positions.min(axis=0).tolist(), 'max': gltf_positions.max(axis=0).tolist()},
            {'bufferView': 1, 'componentType': 5126, 'count': len(uv), 'type': 'VEC2'},
        ],
        'bufferViews': views, 'buffers': [{'byteLength': len(data)}],
    }
    js = json.dumps(gltf, separators=(',', ':')).encode()
    js += b' ' * (-len(js) % 4)
    data.extend(b'\0' * (-len(data) % 4))
    glb = struct.pack('<4sII', b'glTF', 2, 12 + 8 + len(js) + 8 + len(data)) + struct.pack('<I4s', len(js), b'JSON') + js + struct.pack('<I4s', len(data), b'BIN\0') + data
    feature = b'{"BATCH_LENGTH":0}'
    feature += b' ' * (-(28 + len(feature)) % 8)
    result = struct.pack('<4s6I', b'b3dm', 1, 28 + len(feature) + len(glb), len(feature), 0, 0, 0) + feature + glb
    return result


def helsinki(definitions=None, archive_url='https://3d.hel.ninja/data/mesh/Helsinki3D-MESH_2017_OBJ_2km-250m_ZIP/Helsinki3D_2017_OBJ_672496x2.zip'):
    from pyproj import Transformer
    archive = RangeZip(archive_url)
    raw_root = ARTIFACTS / 'helsinki-originals'
    raw_root.mkdir(parents=True, exist_ok=True)
    metadata = archive.read('metadata.xml')
    (raw_root / 'metadata.xml').write_bytes(metadata)
    if b'EPSG:3879+5773' not in metadata or b'25490000,6668000,0' not in metadata:
        raise ValueError('Source spatial reference changed')
    geoid = ARTIFACTS / 'us_nga_egm96_15.tif'
    if not geoid.exists():
        response = requests.get('https://cdn.proj.org/us_nga_egm96_15.tif', timeout=90)
        response.raise_for_status()
        geoid.write_bytes(response.content)
    horizontal = Transformer.from_crs(3879, 4326, always_xy=True)
    geographic = Transformer.from_crs(4978, 4979, always_xy=True)
    to_ecef = Transformer.from_pipeline(f'+proj=pipeline +step +proj=unitconvert +xy_in=deg +xy_out=rad +step +proj=vgridshift +grids={geoid} +multiplier=1 +step +proj=cart +ellps=WGS84')
    definitions = definitions if definitions is not None else [
        {'key': 'helsinki-cathedral', 'title': '芬兰 · 赫尔辛基大教堂', 'center': [24.9522, 60.16995], 'blocks': ['673497a3', '672497b4']},
        {'key': 'helsinki-station', 'title': '芬兰 · 赫尔辛基中央车站', 'center': [24.9415, 60.1707], 'frameCenter': [24.9414, 60.1719], 'blocks': ['673496c1', '673496c2', '673496c3', '673496c4']},
    ]
    for definition in definitions:
        destination = ROOT / 'public/models' / ('world-' + definition['key'])
        destination.mkdir(parents=True, exist_ok=True)
        frame_center = definition.get('frameCenter', definition['center'])
        origin, rotation, transform = local_frame(*frame_center)
        children, files, originals = [], [], []
        bounds = np.array([[np.inf, np.inf, np.inf], [-np.inf, -np.inf, -np.inf]])
        for block in definition['blocks']:
            names = [name for name in archive.files if name.startswith(block + '/') and re.search(r'_L20_.*\.(obj|mtl|jpg)$', name)]
            if not names:
                raise ValueError(f'No source L20 meshes: {block}')
            cached = all((raw_root / name).is_file() for name in names)
            assets = {name: (raw_root / name).read_bytes() for name in names} if cached else archive.read_group(names)
            for name, content in assets.items():
                path = raw_root / name
                path.parent.mkdir(parents=True, exist_ok=True)
                path.write_bytes(content)
                originals.append({'path': name, 'bytes': len(content), 'sha256': sha(content), 'zipCRC32': f'{archive.files[name].CRC:08x}'})
            for name in sorted(name for name in names if name.endswith('.obj')):
                vertices, texcoords, faces = [], [], []
                materials = set()
                active_material = None
                for line in assets[name].decode().splitlines():
                    columns = line.split()
                    if not columns:
                        continue
                    if columns[0] == 'v': vertices.append([float(x) for x in columns[1:4]])
                    elif columns[0] == 'vt': texcoords.append([float(x) for x in columns[1:3]])
                    elif columns[0] == 'usemtl': active_material = columns[1]
                    elif columns[0] == 'f':
                        materials.add(active_material)
                        if len(columns) != 4:
                            raise ValueError('Original source is expected to be triangular')
                        faces.extend([[int(x) - 1 for x in corner.split('/')[:2]] for corner in columns[1:]])
                if len(materials) != 1:
                    raise ValueError('Each source submesh is expected to have one photographic material')
                v = np.array(vertices, dtype=np.float64)
                v[:, :2] += [25490000, 6668000]
                lon, lat = horizontal.transform(v[:, 0], v[:, 1])
                xyz = np.stack(to_ecef.transform(lon, lat, v[:, 2]), axis=1)
                local = np.einsum('ij,jk->ik', xyz - origin, rotation)
                points = np.stack(geographic.transform(xyz[:, 0], xyz[:, 1], xyz[:, 2]), axis=1)
                bounds[0] = np.minimum(bounds[0], points.min(axis=0))
                bounds[1] = np.maximum(bounds[1], points.max(axis=0))
                mapping = np.array(faces, dtype=np.int32)
                positions = local[mapping[:, 0]]
                uv = np.array(texcoords, dtype=np.float32)[mapping[:, 1]]
                mtl = assets[name[:-4] + '.mtl'].decode()
                texture_name = next(line.split(maxsplit=1)[1] for line in mtl.splitlines() if line.startswith('map_Kd '))
                texture = assets[str(Path(name).parent / texture_name)]
                payload = make_b3dm(positions, uv, texture, texture_name)
                output_name = Path(name).stem + '.b3dm'
                (destination / output_name).write_bytes(payload)
                midpoint = (local.min(axis=0) + local.max(axis=0)) / 2
                radius = float(np.linalg.norm(local - midpoint, axis=1).max())
                children.append({'boundingVolume': {'sphere': [*midpoint.tolist(), radius]}, 'geometricError': 0, 'content': {'uri': output_name}})
                files.append({'path': output_name, 'bytes': len(payload), 'sha256': sha(payload), 'sourceOBJ': name, 'triangles': len(mapping) // 3, 'photograph': {'source': texture_name, 'sha256': sha(texture), 'bytes': len(texture)}, 'maxFloat32RoundingErrorMetres': float(np.max(np.abs(positions - positions.astype(np.float32))))})
            print(definition['key'], block, len(files), flush=True)
        region = [math.radians(bounds[0, 0]), math.radians(bounds[0, 1]), math.radians(bounds[1, 0]), math.radians(bounds[1, 1]), bounds[0, 2], bounds[1, 2]]
        # The empty parent must refine: loaders.gl otherwise stops at SSE=0
        # without traversing the original, zero-error final mesh children.
        tileset = {'asset': {'version': '1.0', 'gltfUpAxis': 'Y'}, 'geometricError': 600, 'root': {'boundingVolume': {'region': region}, 'transform': transform, 'geometricError': 600, 'refine': 'ADD', 'children': children}}
        write_json(destination / 'tileset.json', tileset)
        source = {'id': 'world-' + definition['key'] + '-3d', 'title': definition['title'], 'publisher': 'City of Helsinki', 'sourceUrl': 'https://www.hel.fi/en/decision-making/information-on-helsinki/maps-and-geospatial-data/helsinki-3d', 'catalogueUrl': 'https://hri.fi/data/en_GB/dataset/helsingin-3d-kaupunkimalli', 'archiveUrl': archive_url, 'license': 'CC BY 4.0', 'licenseUrl': 'https://creativecommons.org/licenses/by/4.0/', 'attribution': '© City of Helsinki · Helsinki 3D 2017 · CC BY 4.0', 'captureYear': 2017, 'captureYearMeaning': 'Official source archive is the 2017 photography mesh; not a live image or the 2025 server modification date.', 'sourceCRS': 'EPSG:3879+5773', 'sourceOrigin': [25490000, 6668000, 0], 'verticalDatum': 'EGM96 orthometric height, as explicitly declared by the downloaded metadata.xml. The general Helsinki website also describes N2000; this conversion follows the actual archive metadata.', 'geoid': {'url': 'https://cdn.proj.org/us_nga_egm96_15.tif', 'sha256': sha(geoid.read_bytes())}, 'conversion': 'Original L20 source triangles and photographic JPEG bytes retained. OBJ vertices reprojected to WGS84 ECEF with EPSG:3879 inverse and EGM96 geoid correction, then stored as local ENU float32 with a 3D Tiles ECEF transform. Only OBJ-to-glTF UV vertical convention is inverted. No decimation, image resizing, texture recompression, building extrusion, or generated geometry.', 'sourceLevel': 20, 'blocks': definition['blocks'], 'bounds': [bounds[0, 0], bounds[0, 1], bounds[1, 0], bounds[1, 1]], 'heightRangeEllipsoidal': [bounds[0, 2], bounds[1, 2]], 'center': definition['center'], 'frameCenter': frame_center, 'tileCount': len(files), 'tileBytes': sum(item['bytes'] for item in files), 'triangleCount': sum(item['triangles'] for item in files), 'sourceFiles': originals, 'files': files}
        write_json(destination / 'source.json', source)
        print(json.dumps({key: source[key] for key in ['id', 'bounds', 'heightRangeEllipsoidal', 'tileCount', 'tileBytes', 'triangleCount']}), flush=True)


def helsinki_expansions():
    # Only these additional original L20 blocks are generated by this entrypoint.
    helsinki([
        {'key': 'helsinki-uspenski', 'title': '芬兰 · 乌斯别斯基大教堂', 'center': [24.96087, 60.16846], 'blocks': ['672497d4']},
        {'key': 'helsinki-market-square', 'title': '芬兰 · 赫尔辛基集市广场', 'center': [24.9547, 60.1676], 'blocks': ['672497b3', '672497b4', '672497d1', '672497d2']},
    ])
    helsinki([
        {'key': 'helsinki-rock-church', 'title': '芬兰 · 岩石教堂', 'center': [24.92517, 60.1731], 'blocks': ['673495c4']},
    ], 'https://3d.hel.ninja/data/mesh/Helsinki3D-MESH_2017_OBJ_2km-250m_ZIP/Helsinki3D_2017_OBJ_672494x2.zip')
    helsinki([
        {'key': 'helsinki-suomenlinna', 'title': '芬兰 · 芬兰堡大庭院', 'center': [24.98569, 60.14531], 'blocks': ['670499a1', '670499a2', '670499a3', '670499a4']},
    ], 'https://3d.hel.ninja/data/mesh/Helsinki3D-MESH_2017_OBJ_2km-250m_ZIP/Helsinki3D_2017_OBJ_670498x2.zip')


def helsinki_tablet():
    from PIL import Image, __version__ as pillow_version
    for key in ['cathedral', 'station', 'market-square', 'suomenlinna']:
        original = ROOT / 'public/models' / ('world-helsinki-' + key)
        destination = ROOT / 'public/models' / ('world-helsinki-' + key + '-tablet')
        destination.mkdir(parents=True, exist_ok=True)
        source = json.loads((original / 'source.json').read_text())
        source['variantOf'] = source['id']
        source['id'] = source['id'].replace('-3d', '-tablet-3d')
        source['title'] += '（iPad 摄影纹理适配）'
        source['textureVariant'] = 'tablet-resampled'
        source['textureMaxDimension'] = 512
        source['textureRGBABytes'] = 0
        source['textureResampling'] = f'Only photographs exceeding 512 pixels on their longest side are resized proportionally with Pillow {pillow_version} LANCZOS and encoded as JPEG quality 95, 4:4:4. Original geometry, POSITION and UV bytes, transforms, coverage and height are unchanged. Desktop models retain the original official JPEG bytes.'
        source['conversion'] = source['conversion'].replace('Original L20 source triangles and photographic JPEG bytes retained.', 'Original L20 source triangles retained; iPad photography is adapted as declared below.').replace('No decimation, image resizing, texture recompression, building extrusion, or generated geometry.', 'No decimation, building extrusion, or generated geometry.') + ' iPad variant: ' + source['textureResampling']
        (destination / 'tileset.json').write_bytes((original / 'tileset.json').read_bytes())
        for file in source['files']:
            payload = (original / file['path']).read_bytes()
            glb_offset = 28 + sum(struct.unpack_from('<4I', payload, 12))
            json_length = struct.unpack_from('<I', payload, glb_offset + 12)[0]
            document = json.loads(payload[glb_offset + 20:glb_offset + 20 + json_length])
            binary = payload[glb_offset + 28 + json_length:]
            view = document['bufferViews'][document['images'][0]['bufferView']]
            image_start, image_length = view.get('byteOffset', 0), view['byteLength']
            texture = binary[image_start:image_start + image_length]
            with Image.open(io.BytesIO(texture)) as image:
                original_dimensions = list(image.size)
                if max(image.size) > 512:
                    image.thumbnail((512, 512), Image.Resampling.LANCZOS)
                    output = io.BytesIO()
                    image.convert('RGB').save(output, format='JPEG', quality=95, subsampling=0, optimize=True)
                    texture = output.getvalue()
                dimensions = list(image.size)
            view['byteLength'] = len(texture)
            # The image is the final buffer view. All preceding POSITION/UV bytes
            # are copied verbatim, rather than decoded and re-quantized.
            if image_start + image_length + 3 < len(binary):
                raise ValueError('Expected the photograph to be the final buffer view')
            output_binary = binary[:image_start] + texture
            document['buffers'][0]['byteLength'] = len(output_binary)
            output_binary += b'\0' * (-len(output_binary) % 4)
            output_json = json.dumps(document, separators=(',', ':')).encode()
            output_json += b' ' * (-len(output_json) % 4)
            glb = struct.pack('<4sII', b'glTF', 2, 28 + len(output_json) + len(output_binary)) + struct.pack('<I4s', len(output_json), b'JSON') + output_json + struct.pack('<I4s', len(output_binary), b'BIN\0') + output_binary
            prefix = bytearray(payload[:glb_offset])
            struct.pack_into('<I', prefix, 8, len(prefix) + len(glb))
            adapted = bytes(prefix) + glb
            (destination / file['path']).write_bytes(adapted)
            file['bytes'], file['sha256'] = len(adapted), sha(adapted)
            file['photograph'] = {**file['photograph'], 'originalSHA256': file['photograph']['sha256'], 'originalBytes': file['photograph']['bytes'], 'originalDimensions': original_dimensions, 'dimensions': dimensions, 'sha256': sha(texture), 'bytes': len(texture)}
            source['textureRGBABytes'] += dimensions[0] * dimensions[1] * 4
        source['tileBytes'] = sum(file['bytes'] for file in source['files'])
        write_json(destination / 'source.json', source)
        print(json.dumps({'id': source['id'], 'tileBytes': source['tileBytes'], 'textureRGBABytes': source['textureRGBABytes']}), flush=True)


def lyon(mobile=False):
    from PIL import Image
    from pyproj import Transformer
    dataset = 'https://dataset-dl.liris.cnrs.fr/three-d-tiles-lyon-metropolis/'
    base = dataset + '2018/Lyon-1_2018_Textured/'
    raw_root = ARTIFACTS / 'lyon-originals'
    raw_root.mkdir(parents=True, exist_ok=True)

    def download(name, url):
        path = raw_root / name
        if not path.exists():
            response = requests.get(url, timeout=90)
            response.raise_for_status()
            path.write_bytes(response.content)
        return path.read_bytes()

    metadata = json.loads(download('tileset.json', base + 'tileset.json'))
    readme = download('README.txt', dataset + 'README.txt')
    if b'This dataset is published under the ETALAB v2.0 open license' not in readme:
        raise ValueError('LIRIS dataset license declaration changed')
    download('ETALAB-Licence-Ouverte-v2.0_EN.pdf', dataset + 'ETALAB-Licence-Ouverte-v2.0_EN.pdf')
    geoid = ARTIFACTS / 'fr_ign_RAF18.tif'
    if not geoid.exists():
        response = requests.get('https://cdn.proj.org/fr_ign_RAF18.tif', timeout=90)
        response.raise_for_status()
        geoid.write_bytes(response.content)
    horizontal = Transformer.from_crs(3946, 4326, always_xy=True)
    geographic = Transformer.from_crs(4978, 4979, always_xy=True)
    to_ecef = Transformer.from_pipeline(f'+proj=pipeline +step +proj=unitconvert +xy_in=deg +xy_out=rad +step +proj=vgridshift +grids={geoid} +multiplier=1 +step +proj=cart +ellps=WGS84')
    center = [4.83505, 45.7677]
    origin, rotation, transform = local_frame(*center)
    destination = ROOT / ('public/models/world-lyon-cityhall-mobile' if mobile else 'public/models/world-lyon-cityhall')
    destination.mkdir(parents=True, exist_ok=True)
    children, files, originals = [], [], []
    bounds = np.array([[np.inf, np.inf, np.inf], [-np.inf, -np.inf, -np.inf]])
    building_ids = set()
    # Mobile uses the source's penultimate photographic texture LOD. Its
    # geometry is unchanged; retain the finest original atlases on desktop.
    for cluster in [77, 88, 89, 92]:
        node = metadata['root']['children'][cluster]
        source_origin = np.array(node['transform'][12:15])
        while node.get('children') and (not mobile or node['children'][0].get('children')):
            node = node['children'][0]
        uri = node['content']['uri']
        name = Path(uri).name
        data = download(name, base + uri)
        header = struct.unpack_from('<4s6I', data)
        if header[0] != b'b3dm' or header[1] != 1 or header[2] != len(data):
            raise ValueError('Invalid original 3D Tiles payload')
        batch_offset = 28 + header[3] + header[4]
        batch = json.loads(data[batch_offset:batch_offset + header[5]])
        building_ids.update(batch['gml_id'])
        offset = 28 + sum(header[3:7])
        length = struct.unpack_from('<I', data, offset + 12)[0]
        gltf = json.loads(data[offset + 20:offset + 20 + length])
        binary = data[offset + 20 + length + 8:]
        primitive = gltf['meshes'][0]['primitives'][0]
        if 'indices' in primitive or primitive['mode'] != 4:
            raise ValueError('Expected original unindexed triangles')
        if gltf['nodes'][0]['matrix'] != [1, 0, 0, 0, 0, 0, -1, 0, 0, 1, 0, 0, 0, 0, 0, 1]:
            raise ValueError('Original projected XYZ axis convention changed')

        def attribute(key, size):
            accessor = gltf['accessors'][primitive['attributes'][key]]
            if accessor['componentType'] != 5126:
                raise ValueError('Expected original Float32 attributes')
            view = gltf['bufferViews'][accessor['bufferView']]
            start = view.get('byteOffset', 0) + accessor.get('byteOffset', 0)
            return np.frombuffer(binary, dtype='<f4', count=accessor['count'] * size, offset=start).reshape(-1, size).copy()

        projected = attribute('POSITION', 3).astype(np.float64) + source_origin
        uv = attribute('TEXCOORD_0', 2)
        texture_name = Path(gltf['images'][0]['uri']).name
        texture = download(texture_name, base + 'tiles/' + texture_name)
        lon, lat = horizontal.transform(projected[:, 0], projected[:, 1])
        xyz = np.stack(to_ecef.transform(lon, lat, projected[:, 2]), axis=1)
        local = np.einsum('ij,jk->ik', xyz - origin, rotation)
        points = np.stack(geographic.transform(xyz[:, 0], xyz[:, 1], xyz[:, 2]), axis=1)
        bounds[0] = np.minimum(bounds[0], points.min(axis=0))
        bounds[1] = np.maximum(bounds[1], points.max(axis=0))
        if not np.isfinite(local).all() or len(local) % 3:
            raise ValueError('Invalid original vertex coordinates')
        # Source UVs already follow glTF's vertical convention.
        payload = make_b3dm(local, uv, texture, texture_name, flip_v=False)
        (destination / name).write_bytes(payload)
        midpoint = (local.min(axis=0) + local.max(axis=0)) / 2
        radius = float(np.linalg.norm(local - midpoint, axis=1).max())
        children.append({'boundingVolume': {'sphere': [*midpoint.tolist(), radius]}, 'geometricError': 0, 'content': {'uri': name}})
        files.append({'path': name, 'bytes': len(payload), 'sha256': sha(payload), 'sourceB3DM': name, 'sourceCluster': cluster, 'sourceOrigin': source_origin.tolist(), 'triangles': len(local) // 3, 'photograph': {'source': texture_name, 'sha256': sha(texture), 'bytes': len(texture), 'dimensions': list(Image.open(io.BytesIO(texture)).size)}, 'maxFloat32RoundingErrorMetres': float(np.max(np.abs(local - local.astype(np.float32))))})
        for original_name, content in [(name, data), (texture_name, texture)]:
            originals.append({'path': original_name, 'bytes': len(content), 'sha256': sha(content), 'url': base + 'tiles/' + original_name})
    region = [math.radians(bounds[0, 0]), math.radians(bounds[0, 1]), math.radians(bounds[1, 0]), math.radians(bounds[1, 1]), bounds[0, 2], bounds[1, 2]]
    write_json(destination / 'tileset.json', {'asset': {'version': '1.0', 'gltfUpAxis': 'Y'}, 'geometricError': 600, 'root': {'boundingVolume': {'region': region}, 'transform': transform, 'geometricError': 600, 'refine': 'ADD', 'children': children}})
    source = {'id': 'world-lyon-cityhall-3d', 'title': '法国 · 里昂市政厅', 'kind': 'reconstruction', 'publisher': 'Métropole de Lyon; 3D Tiles conversion by VCity team, LIRIS', 'sourceUrl': 'https://data.grandlyon.com/portail/fr/jeux-de-donnees/maquettes-3d-texturees-2018-communes-metropole-lyon/info', 'catalogueUrl': 'https://github.com/VCityTeam/UD-Demo-vcity-py3dtilers-lyon/blob/master/doc/textured.md', 'archiveUrl': base + 'tileset.json', 'license': 'Licence Ouverte 2.0', 'licenseUrl': dataset + 'ETALAB-Licence-Ouverte-v2.0_EN.pdf', 'licenseDeclarationUrl': dataset + 'README.txt', 'licenseDeclarationSHA256': sha(readme), 'attribution': '© Métropole de Lyon 2018 · VCity / LIRIS · Licence Ouverte 2.0', 'captureYear': 2018, 'captureYearMeaning': 'Grand Lyon metadata: vertical and oblique photography acquired April–July 2018, not a live scene.', 'sourceCRS': 'EPSG:3946', 'verticalDatum': 'NGF-IGN69 assumed from Métropole de Lyon official CC46/NGF-IGN69 topographic reference; the 2018 CityGML itself declares only horizontal EPSG:3946, not a vertical CRS. IGN RAF18 converts this assumed local orthometric height to ellipsoidal height. This is a documented datum assumption, not a survey accuracy claim.', 'verticalReferenceUrl': 'https://data.grandlyon.com/portail/fr/jeux-de-donnees/plans-topographiques-metropole-lyon/info', 'geoid': {'url': 'https://cdn.proj.org/fr_ign_RAF18.tif', 'sha256': sha(geoid.read_bytes())}, 'conversion': 'Finest source texture LOD of four LIRIS clusters. Original LoD2 building geometry and source atlas JPEG bytes retained, not photogrammetry mesh. Original CC46 XYZ vertices plus source node translations reprojected to WGS84 ECEF with the documented NGF-IGN69 assumption and IGN RAF18 correction; stored as local ENU float32 with double-precision root ECEF transform. Original glTF UVs retained. No decimation, texture resizing, recompression, procedural buildings or generated textures.', 'sourceClusters': [77, 88, 89, 92], 'buildingIds': sorted(building_ids), 'bounds': [bounds[0, 0], bounds[0, 1], bounds[1, 0], bounds[1, 1]], 'heightRangeEllipsoidal': [bounds[0, 2], bounds[1, 2]], 'center': center, 'tileCount': len(files), 'tileBytes': sum(item['bytes'] for item in files), 'triangleCount': sum(item['triangles'] for item in files), 'sourceFiles': originals, 'files': files}
    if mobile:
        source.update({'id': 'world-lyon-cityhall-mobile-3d', 'variantOf': 'world-lyon-cityhall-3d', 'textureVariant': 'Penultimate native LIRIS texture LOD, original JPEG bytes without resizing or recompression. All geometry and source building IDs are identical to the desktop finest-texture variant.', 'textureRGBABytes': sum(file['photograph']['dimensions'][0] * file['photograph']['dimensions'][1] * 4 for file in files)})
        source['conversion'] = source['conversion'].replace('Finest source texture LOD', 'Penultimate native source texture LOD')
    write_json(destination / 'source.json', source)
    print(json.dumps({key: source[key] for key in ['id', 'bounds', 'heightRangeEllipsoidal', 'tileCount', 'tileBytes', 'triangleCount']}), flush=True)


def lyon_terrain():
    """Rasterize the official 2018 ground TIN; retain Mapzen outside the TIN."""
    from PIL import Image
    from pyproj import Transformer
    archive_url = 'https://download.data.grandlyon.com/files/grandlyon/imagerie/2018/maquette/LYON_1ER_2018.zip'
    member = 'LYON_1ER_2018/LYON_1ER_TIN_2018.gml'
    raw_path = ARTIFACTS / 'lyon-originals' / Path(member).name
    if not raw_path.exists():
        # The official service ignores Range. Stop the response after the ground
        # member, before the multi-GB photograph collection following it.
        with requests.get(archive_url, stream=True, timeout=180) as response:
            response.raise_for_status()
            while True:
                header = struct.unpack('<I5H3I2H', response.raw.read(30))
                if header[0] != 0x04034b50 or header[3] != 0 or header[2] & 8:
                    raise ValueError('Expected stored ZIP members with known sizes')
                name = response.raw.read(header[-2]).decode()
                response.raw.read(header[-1])
                if name == member:
                    data = response.raw.read(header[7])
                    if len(data) != header[8] or binascii.crc32(data) & 0xffffffff != header[6]:
                        raise ValueError('Official ground member CRC mismatch')
                    raw_path.parent.mkdir(parents=True, exist_ok=True)
                    raw_path.write_bytes(data)
                    break
                remaining = header[7]
                while remaining:
                    skipped = response.raw.read(min(remaining, 1_048_576))
                    if not skipped:
                        raise ValueError('Incomplete official ZIP stream')
                    remaining -= len(skipped)
    raw = raw_path.read_bytes()
    triangles = np.array([np.fromstring(match.group(1).decode(), sep=' ').reshape(-1, 3)[:3]
                          for match in re.finditer(rb'<gml:posList>([^<]+)</gml:posList>', raw)])
    if triangles.shape != (95391, 3, 3) or not np.isfinite(triangles).all():
        raise ValueError('Official 2018 ground TIN changed')
    zoom, west_tile, north_tile, side = 14, 8411, 5842, 3
    size = side * 256
    world_pixels = 256 * 2 ** zoom
    x_pixels, y_pixels = np.meshgrid(np.arange(west_tile * 256, (west_tile + side) * 256) + .5,
                                    np.arange(north_tile * 256, (north_tile + side) * 256) + .5)
    longitude = x_pixels / world_pixels * 360 - 180
    latitude = np.degrees(np.arctan(np.sinh(np.pi * (1 - 2 * y_pixels / world_pixels))))
    to_projected = Transformer.from_crs(4326, 3946, always_xy=True)
    to_geographic = Transformer.from_crs(3946, 4326, always_xy=True)
    grid_x, grid_y = to_projected.transform(longitude, latitude)
    fallback_rgb = np.zeros((size, size, 3), dtype=np.uint8)
    fallbacks = []
    for tile_y in range(north_tile, north_tile + side):
        for tile_x in range(west_tile, west_tile + side):
            path = ROOT / f'public/tiles/terrain-webp/{zoom}/{tile_x}/{tile_y}.webp'
            rgb = np.array(Image.open(path).convert('RGB'))
            row, column = (tile_y - north_tile) * 256, (tile_x - west_tile) * 256
            fallback_rgb[row:row + 256, column:column + 256] = rgb
            fallbacks.append({'tile': f'{zoom}/{tile_x}/{tile_y}', 'localPath': str(path.relative_to(ROOT / 'public')), 'sha256': sha(path.read_bytes()), 'rgbSHA256': sha(rgb.tobytes()), 'url': f'https://s3.amazonaws.com/elevation-tiles-prod/terrarium/{zoom}/{tile_x}/{tile_y}.png'})
    heights = fallback_rgb[:, :, 0].astype(float) * 256 + fallback_rgb[:, :, 1] + fallback_rgb[:, :, 2] / 256 - 32768
    owners = np.full((size, size), -1, dtype=np.int32)
    lon, lat = to_geographic.transform(triangles[:, :, 0], triangles[:, :, 1])
    pixel_x = (lon + 180) / 360 * world_pixels - west_tile * 256
    pixel_y = (1 - np.arcsinh(np.tan(np.radians(lat))) / np.pi) / 2 * world_pixels - north_tile * 256
    # Candidate bounds include a pixel of padding; membership and height are
    # calculated in the original CC46 triangle, not in reprojected triangles.
    for index, triangle in enumerate(triangles):
        left = max(0, math.floor(pixel_x[index].min() - 1))
        right = min(size, math.ceil(pixel_x[index].max() + 1))
        top = max(0, math.floor(pixel_y[index].min() - 1))
        bottom = min(size, math.ceil(pixel_y[index].max() + 1))
        if right <= left or bottom <= top:
            continue
        a, b, c = triangle
        ab, ac = b[:2] - a[:2], c[:2] - a[:2]
        determinant = ab[0] * ac[1] - ac[0] * ab[1]
        if abs(determinant) < 1e-12:
            continue
        dx = grid_x[top:bottom, left:right] - a[0]
        dy = grid_y[top:bottom, left:right] - a[1]
        u = (dx * ac[1] - ac[0] * dy) / determinant
        v = (ab[0] * dy - dx * ab[1]) / determinant
        inside = (u >= -1e-9) & (v >= -1e-9) & (u + v <= 1 + 1e-9)
        heights[top:bottom, left:right][inside] = ((1 - u - v) * a[2] + u * b[2] + v * c[2])[inside]
        owners[top:bottom, left:right][inside] = index
    packed = np.rint((heights + 32768) * 256).astype(np.uint32)
    rgb = np.stack([packed >> 16, packed >> 8 & 255, packed & 255], axis=2).astype(np.uint8)
    mask = owners >= 0
    decoded = rgb[:, :, 0].astype(float) * 256 + rgb[:, :, 1] + rgb[:, :, 2] / 256 - 32768
    error = float(np.max(np.abs(decoded[mask] - heights[mask])))
    if error > 1 / 256 or not np.array_equal(rgb[~mask], fallback_rgb[~mask]):
        raise ValueError('Ground encoding changed fallback pixels or exceeded precision')
    destination = ROOT / 'public/models/world-lyon-cityhall-terrain'
    files = []

    def png_chunk(kind, value):
        return struct.pack('>I', len(value)) + kind + value + struct.pack('>I', binascii.crc32(kind + value) & 0xffffffff)

    for tile_y in range(north_tile, north_tile + side):
        for tile_x in range(west_tile, west_tile + side):
            row, column = (tile_y - north_tile) * 256, (tile_x - west_tile) * 256
            pixels = rgb[row:row + 256, column:column + 256]
            tile_mask = mask[row:row + 256, column:column + 256]
            scanlines = b''.join(b'\0' + pixels[r].tobytes() for r in range(256))
            payload = b'\x89PNG\r\n\x1a\n' + png_chunk(b'IHDR', struct.pack('>IIBBBBB', 256, 256, 8, 2, 0, 0, 0)) + png_chunk(b'IDAT', zlib.compress(scanlines, 9)) + png_chunk(b'IEND', b'')
            path = destination / f'{zoom}/{tile_x}/{tile_y}.png'
            path.parent.mkdir(parents=True, exist_ok=True)
            path.write_bytes(payload)
            if not np.array_equal(np.array(Image.open(io.BytesIO(payload))), pixels):
                raise ValueError('PNG RGB round-trip changed elevation values')
            samples = [{'pixel': [x, y], 'rgb': pixels[y, x].tolist()} for y in [0, 64, 128, 192, 255] for x in [0, 64, 128, 192, 255] if not tile_mask[y, x]]
            files.append({'path': str(path.relative_to(destination)), 'bytes': len(payload), 'sha256': sha(payload), 'rgbSHA256': sha(pixels.tobytes()), 'officialTINPixels': int(tile_mask.sum()), 'fallbackSamples': samples})
    samples = []
    targets = [('市政厅中心', 4.83505, 45.7677), ('歌剧院', 4.83656, 45.76773), ('沃土广场', 4.8341, 45.7676), ('市政厅东街', 4.83598, 45.7677), ('市政厅南街', 4.83505, 45.76728)]
    targets += [(f'片区网格{x}-{y}', 4.8337 + x * .00075, 45.7671 + y * .00038) for y in range(5) for x in range(5)]
    for label, lon, lat in targets:
        column = math.floor((lon + 180) / 360 * world_pixels) - west_tile * 256
        row = math.floor((1 - math.asinh(math.tan(math.radians(lat))) / math.pi) / 2 * world_pixels) - north_tile * 256
        triangle = int(owners[row, column])
        if triangle < 0:
            raise ValueError('Official TIN does not cover a required scene sample')
        samples.append({'label': label, 'tile': f'{zoom}/{west_tile + column // 256}/{north_tile + row // 256}', 'pixel': [column % 256, row % 256], 'coordinate': [float(longitude[row, column]), float(latitude[row, column])], 'cc46': [float(grid_x[row, column]), float(grid_y[row, column])], 'sourceTriangleIndex': triangle, 'sourceTriangle': triangles[triangle].tolist(), 'sourceHeightMetres': float(heights[row, column]), 'encodedHeightMetres': float(decoded[row, column]), 'previousMapzenHeightMetres': float(fallback_rgb[row, column, 0]) * 256 + float(fallback_rgb[row, column, 1]) + float(fallback_rgb[row, column, 2]) / 256 - 32768})
    bounds = [west_tile / 2 ** zoom * 360 - 180, math.degrees(math.atan(math.sinh(math.pi * (1 - 2 * (north_tile + side) / 2 ** zoom)))), (west_tile + side) / 2 ** zoom * 360 - 180, math.degrees(math.atan(math.sinh(math.pi * (1 - 2 * north_tile / 2 ** zoom))))]
    source = {'id': 'world-lyon-cityhall-terrain', 'sourceUrl': 'https://data.grandlyon.com/portail/fr/jeux-de-donnees/maquettes-3d-texturees-2018-communes-metropole-lyon/info', 'archiveUrl': archive_url, 'sourceMember': member, 'sourceBytes': len(raw), 'sourceSHA256': sha(raw), 'sourceCRC32': f'{binascii.crc32(raw) & 0xffffffff:08x}', 'license': 'Licence Ouverte 2.0', 'licenseUrl': 'https://www.etalab.gouv.fr/wp-content/uploads/2017/04/ETALAB-Licence-Ouverte-v2.0.pdf', 'attribution': '© Métropole de Lyon 2018 · Licence Ouverte 2.0; outside the official TIN: © Mapzen, USGS, NASA', 'sourceCRS': 'EPSG:3946', 'verticalDatum': 'Source NGF-IGN69 orthometric height follows the same documented local datum assumption as the 2018 buildings. No ellipsoid-height offset is applied to this ground raster. Outside the official TIN, original Mapzen Terrarium height values remain unchanged.', 'sourceTriangleCount': len(triangles), 'method': 'At every Web Mercator z14 pixel centre, transform WGS84 longitude/latitude to original CC46 and interpolate barycentric height inside the original 2018 TIN triangle. Preserve existing Mapzen decoded RGB exactly outside the TIN. Round height to nearest 1/256m in lossless RGB Terrarium PNG. No smoothing, constant flattening, building shifts, arbitrary height offsets, or modification of the original Mapzen cache. Emit ordinary 256x256 tiles; MapLibre builds its own one-pixel neighbour border.', 'tileSize': 256, 'encoding': 'terrarium', 'zoom': zoom, 'bounds': bounds, 'officialTINPixels': int(mask.sum()), 'fallbackPixels': int((~mask).sum()), 'maxEncodingErrorMetres': error, 'fallbacks': fallbacks, 'files': files, 'validationSamples': samples}
    write_json(destination / 'source.json', source)
    write_json(destination / 'tilejson.json', {'tilejson': '3.0.0', 'name': 'Lyon 2018 official ground with unchanged Mapzen fallback', 'scheme': 'xyz', 'format': 'png', 'encoding': 'terrarium', 'tileSize': 256, 'minzoom': zoom, 'maxzoom': zoom, 'bounds': bounds, 'tiles': ['14/{x}/{y}.png'], 'attribution': source['attribution']})
    print(json.dumps({'id': source['id'], 'bounds': bounds, 'bytes': sum(file['bytes'] for file in files), 'officialTINPixels': source['officialTINPixels'], 'maxEncodingErrorMetres': error, 'landmarks': samples[:5]}, ensure_ascii=False), flush=True)


def main():
    helsinki()
    helsinki_expansions()
    helsinki_tablet()
    lyon()
    lyon(mobile=True)
    lyon_terrain()


if __name__ == '__main__':
    main()
