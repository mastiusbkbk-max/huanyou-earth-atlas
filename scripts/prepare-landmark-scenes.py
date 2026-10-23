#!/usr/bin/env python3
"""Prepare attributed Melbourne photography meshes for desktop and iPad.

Requires numpy, requests, Pillow and pyproj, as prepare-world-scenes.py does.
Only the selected original L20 ZIP members are fetched with HTTP Range.
"""
import io
import json
import math
from pathlib import Path
import re
import runpy
import struct
import sys

import numpy as np
from PIL import Image
from pyproj import Transformer
import requests

ROOT = Path(__file__).resolve().parents[1]
ARTIFACTS = ROOT / 'artifacts/landmark-scenes'
HELPERS = runpy.run_path(str(ROOT / 'scripts/prepare-world-scenes.py'))
RangeZip = HELPERS['RangeZip']
make_b3dm = HELPERS['make_b3dm']
local_frame = HELPERS['local_frame']
write_json = HELPERS['write_json']
sha = HELPERS['sha']
ARCHIVE = 'https://opendatasoft-s3.s3.amazonaws.com/attachments/3DTexturedMesh/CoM_3D_Mesh_2018_OBJ.zip'
CATALOGUE = 'https://data.melbourne.vic.gov.au/explore/dataset/city-of-melbourne-3d-textured-mesh-photomesh-2018/'
CATALOGUE_API = 'https://data.melbourne.vic.gov.au/api/explore/v2.1/catalog/datasets/city-of-melbourne-3d-textured-mesh-photomesh-2018'
LICENSE = 'https://creativecommons.org/licenses/by/4.0/legalcode'
ATTRIBUTION = '© City of Melbourne · Photomesh 2018 · CC BY 4.0'
DEFINITIONS = [
    {'key': 'melbourne-flinders', 'title': '澳大利亚 · 弗林德斯街车站', 'blocks': ['Tile_+015_+010', 'Tile_+016_+010'], 'center': [144.9670, -37.81825], 'elevation': 18},
    {'key': 'melbourne-exhibition', 'title': '澳大利亚 · 皇家展览馆', 'blocks': ['Tile_+016_+013', 'Tile_+017_+013'], 'center': [144.9714, -37.8047], 'elevation': 48},
    {'key': 'melbourne-shrine', 'title': '澳大利亚 · 战争纪念馆', 'blocks': ['Tile_+017_+008'], 'center': [144.9735, -37.8305], 'elevation': 38},
]


def original(archive, name):
    path = ARTIFACTS / 'originals' / name
    if not path.exists():
        path.parent.mkdir(parents=True, exist_ok=True)
        path.write_bytes(archive.read(name))
    data = path.read_bytes()
    return data, {'path': name, 'bytes': len(data), 'sha256': sha(data), 'zipCRC32': f'{archive.files[name].CRC:08x}'}


def parse_obj(data):
    vertices, texcoords, faces = [], [], {}
    material = None
    for line in data.decode().splitlines():
        columns = line.split()
        if not columns:
            continue
        if columns[0] == 'v':
            vertices.append([float(v) for v in columns[1:4]])
        elif columns[0] == 'vt':
            texcoords.append([float(v) for v in columns[1:3]])
        elif columns[0] == 'usemtl':
            material = columns[1]
        elif columns[0] == 'f':
            if len(columns) != 4 or material is None:
                raise ValueError('Expected original triangular, textured faces')
            faces.setdefault(material, []).extend([[int(v) - 1 for v in corner.split('/')[:2]] for corner in columns[1:]])
    return np.array(vertices, dtype=np.float64), np.array(texcoords, dtype=np.float32), faces


def prepare():
    ARTIFACTS.mkdir(parents=True, exist_ok=True)
    response = requests.get(CATALOGUE_API, timeout=60)
    response.raise_for_status()
    catalogue = response.json()['metas']['default']
    if catalogue['license_url'] != LICENSE or '2018' not in catalogue['title']:
        raise ValueError('Official capture/license declaration changed')
    (ARTIFACTS / 'melbourne-catalogue-2018.json').write_bytes(response.content)
    archive = RangeZip(ARCHIVE)
    metadata, metadata_record = original(archive, 'CoM_3D_Mesh_2018_OBJ/metadata.xml')
    if b'EPSG:28355+5773' not in metadata or b'319000,5813000,0' not in metadata:
        raise ValueError('Official archive spatial reference changed')
    geoid = ROOT / 'artifacts/world-scenes/us_nga_egm96_15.tif'
    if not geoid.exists():
        response = requests.get('https://cdn.proj.org/us_nga_egm96_15.tif', timeout=90)
        response.raise_for_status()
        geoid.write_bytes(response.content)
    horizontal = Transformer.from_crs(28355, 4326, always_xy=True)
    geographic = Transformer.from_crs(4978, 4979, always_xy=True)
    to_ecef = Transformer.from_pipeline(f'+proj=pipeline +step +proj=unitconvert +xy_in=deg +xy_out=rad +step +proj=vgridshift +grids={geoid} +multiplier=1 +step +proj=cart +ellps=WGS84')
    configurations = []
    for definition in DEFINITIONS:
        directory = ROOT / 'public/models' / ('world-' + definition['key'])
        directory.mkdir(parents=True, exist_ok=True)
        source_files = [metadata_record]
        files, children, texture_bytes = [], [], 0
        geographic_blocks = []
        origin, rotation, transform = local_frame(*definition['center'])
        for block in definition['blocks']:
            prefix = 'CoM_3D_Mesh_2018_OBJ/Data/' + block + '/'
            mesh_name = prefix + block + '_L20.obj'
            mtl_name = mesh_name[:-4] + '.mtl'
            mesh, mesh_record = original(archive, mesh_name)
            mtl, mtl_record = original(archive, mtl_name)
            source_files.extend([mesh_record, mtl_record])
            positions, texcoords, face_groups = parse_obj(mesh)
            positions[:, :2] += [319000, 5813000]
            longitude, latitude = horizontal.transform(positions[:, 0], positions[:, 1])
            xyz = np.stack(to_ecef.transform(longitude, latitude, positions[:, 2]), axis=1)
            geo = np.stack(geographic.transform(xyz[:, 0], xyz[:, 1], xyz[:, 2]), axis=1)
            delta = xyz - origin
            local = np.stack([sum(delta[:, axis] * rotation[axis, column] for axis in range(3)) for column in range(3)], axis=1)
            if not np.isfinite(local).all():
                raise ValueError('Source coordinates must transform to finite local metres')
            geographic_blocks.append(geo)
            materials = dict(re.findall(r'newmtl\s+(\S+)\s+.*?map_Kd\s+([^\r\n]+)', mtl.decode(), re.S))
            for index, (material, faces) in enumerate(face_groups.items()):
                mapping = np.array(faces, dtype=np.int32)
                texture_name = materials[material].strip()
                photo, photo_record = original(archive, prefix + texture_name)
                source_files.append(photo_record)
                image = Image.open(io.BytesIO(photo)).convert('RGB')
                original_dimensions = list(image.size)
                # Preserve every L20 triangle. Bound only texture upload size for iPad.
                if max(image.size) > 4096:
                    image.thumbnail((4096, 4096), Image.Resampling.LANCZOS)
                    output = io.BytesIO()
                    image.save(output, 'JPEG', quality=94, subsampling=0, optimize=True)
                    texture = output.getvalue()
                else:
                    texture = photo
                dimensions = list(image.size)
                texture_bytes += image.width * image.height * 4
                points = local[mapping[:, 0]]
                payload = make_b3dm(points, texcoords[mapping[:, 1]], texture, texture_name)
                filename = f'{block}_L20_{index}.b3dm'
                (directory / filename).write_bytes(payload)
                midpoint = (points.min(axis=0) + points.max(axis=0)) / 2
                radius = float(np.linalg.norm(points - midpoint, axis=1).max())
                children.append({'boundingVolume': {'sphere': [*midpoint.tolist(), radius]}, 'geometricError': 0, 'content': {'uri': filename}})
                files.append({'path': filename, 'bytes': len(payload), 'sha256': sha(payload), 'sourceMesh': mesh_name, 'sourceMaterial': material, 'triangles': len(mapping) // 3, 'photograph': {'source': texture_name, 'bytes': len(texture), 'sha256': sha(texture), 'dimensions': dimensions, 'originalDimensions': original_dimensions, 'originalSHA256': sha(photo)}, 'maxFloat32RoundingErrorMetres': float(np.max(np.abs(points - points.astype(np.float32))))})
        geo = np.concatenate(geographic_blocks)
        bounds = [float(geo[:, 0].min()), float(geo[:, 1].min()), float(geo[:, 0].max()), float(geo[:, 1].max())]
        heights = [float(geo[:, 2].min()), float(geo[:, 2].max())]
        region = [math.radians(v) for v in bounds] + heights
        tileset = {'asset': {'version': '1.0', 'gltfUpAxis': 'Y'}, 'geometricError': 600, 'root': {'boundingVolume': {'region': region}, 'transform': transform, 'geometricError': 600, 'refine': 'ADD', 'children': children}}
        write_json(directory / 'tileset.json', tileset)
        scene_id = 'world-' + definition['key'] + '-3d'
        source = {'id': scene_id, 'title': definition['title'], 'publisher': 'City of Melbourne', 'sourceUrl': CATALOGUE, 'archiveUrl': ARCHIVE, 'license': 'CC BY 4.0', 'licenseUrl': LICENSE, 'attribution': ATTRIBUTION, 'captureYear': 2018, 'sourceCRS': 'EPSG:28355+5773', 'sourceOrigin': [319000, 5813000, 0], 'verticalDatum': 'EGM96 orthometric height follows the actual archive metadata.xml (EPSG:28355+5773). The web catalogue instead describes AHD; this conflict is retained explicitly rather than asserting survey-grade vertical accuracy.', 'geoid': {'url': 'https://cdn.proj.org/us_nga_egm96_15.tif', 'sha256': sha(geoid.read_bytes())}, 'conversion': 'Every original L20 triangular face retained without decimation. Source GDA94/MGA55 positions converted to WGS84 ECEF using the archive origin and declared EGM96 vertical CRS, then stored in local ENU float32 with a double precision ECEF transform. Source UVs retain their mapping with the required OBJ-to-glTF vertical flip. Original photographic textures above 4096 pixels are downsampled with Lanczos and JPEG quality 94 solely to bound iPad texture memory; no generated content or substitute texture.', 'sourceLevel': 20, 'blocks': definition['blocks'], 'bounds': bounds, 'heightRangeEllipsoidal': heights, 'center': definition['center'], 'tileCount': len(files), 'tileBytes': sum(f['bytes'] for f in files), 'triangleCount': sum(f['triangles'] for f in files), 'textureRGBABytes': texture_bytes, 'sourceFiles': source_files, 'files': files}
        write_json(directory / 'source.json', source)
        center_ecef = to_ecef.transform(*definition['center'], 0)
        geoid_height = geographic.transform(*center_ecef)[2]
        configurations.append({'id': scene_id, 'placeId': 'world-melbourne', 'name': definition['title'], 'country': '澳大利亚', 'continent': '大洋洲', 'sheet': 'City of Melbourne 2018 · ' + ', '.join(definition['blocks']) + ' · L20', 'bounds': bounds, 'center': definition['center'], 'zoom': 17.0, 'pitch': 55, 'bearing': -25, 'elevation': definition['elevation'], 'datumOffset': -geoid_height, 'url': f'models/world-{definition["key"]}/tileset.json', 'sourceUrl': CATALOGUE, 'licenseUrl': LICENSE, 'attribution': ATTRIBUTION, 'scope': f'2018 年真实航拍摄影网格，覆盖地标及周围约 {len(definition["blocks"]) * 500} × 500 米；模型最高精度几何保留，周围仍为卫星影像。'})
        print(json.dumps({k: source[k] for k in ['id', 'bounds', 'tileCount', 'tileBytes', 'triangleCount', 'textureRGBABytes']}, ensure_ascii=False), flush=True)
    write_json(ARTIFACTS / 'scene-configurations.json', configurations)


def audit():
    """Reverse-project every published triangle corner into the original CRS."""
    geoid = ROOT / 'artifacts/world-scenes/us_nga_egm96_15.tif'
    to_ecef = Transformer.from_pipeline(f'+proj=pipeline +step +proj=unitconvert +xy_in=deg +xy_out=rad +step +proj=vgridshift +grids={geoid} +multiplier=1 +step +proj=cart +ellps=WGS84')
    horizontal = Transformer.from_crs(4326, 28355, always_xy=True)
    report = []
    for definition in DEFINITIONS:
        directory = ROOT / 'public/models' / ('world-' + definition['key'])
        source = json.loads((directory / 'source.json').read_text())
        tileset = json.loads((directory / 'tileset.json').read_text())
        matrix = np.array(tileset['root']['transform']).reshape((4, 4), order='F')
        for mesh in dict.fromkeys(file['sourceMesh'] for file in source['files']):
            positions, uv, groups = parse_obj((ARTIFACTS / 'originals' / mesh).read_bytes())
            positions[:, :2] += source['sourceOrigin'][:2]
            for file in (file for file in source['files'] if file['sourceMesh'] == mesh):
                payload = (directory / file['path']).read_bytes()
                header = struct.unpack_from('<4s6I', payload)
                offset = 28 + sum(header[3:])
                json_length = struct.unpack_from('<I', payload, offset + 12)[0]
                document = json.loads(payload[offset + 20:offset + 20 + json_length])
                binary = memoryview(payload)[offset + 28 + json_length:]
                primitive = document['meshes'][0]['primitives'][0]
                arrays = {}
                for name, size in [('POSITION', 3), ('TEXCOORD_0', 2)]:
                    accessor = document['accessors'][primitive['attributes'][name]]
                    view = document['bufferViews'][accessor['bufferView']]
                    arrays[name] = np.frombuffer(binary, dtype='<f4', count=accessor['count'] * size, offset=view.get('byteOffset', 0)).reshape((-1, size))
                mapping = np.array(groups[file['sourceMaterial']], dtype=np.int32)
                gltf = arrays['POSITION'].astype(np.float64)
                enu = np.stack([gltf[:, 0], -gltf[:, 2], gltf[:, 1]], axis=1)
                xyz = np.stack([sum(enu[:, axis] * matrix[row, axis] for axis in range(3)) + matrix[row, 3] for row in range(3)], axis=1)
                lon, lat, height = to_ecef.transform(xyz[:, 0], xyz[:, 1], xyz[:, 2], direction='INVERSE')
                x, y = horizontal.transform(lon, lat)
                reconstructed = np.stack([x, y, height], axis=1)
                original_positions = positions[mapping[:, 0]]
                if reconstructed.shape != original_positions.shape or not np.isfinite(reconstructed).all():
                    raise ValueError('Published geometry does not match the original face corners')
                errors = np.max(np.abs(reconstructed - original_positions), axis=0)
                original_uv = uv[mapping[:, 1]].copy()
                original_uv[:, 1] = 1 - original_uv[:, 1]
                uv_error = float(np.max(np.abs(arrays['TEXCOORD_0'] - original_uv)))
                if max(errors) > 0.001 or uv_error > 1e-6:
                    raise ValueError(f'Original face audit failed: {file["path"]}, {errors}, {uv_error}')
                report.append({'scene': source['id'], 'file': file['path'], 'triangles': len(mapping) // 3, 'cornersChecked': len(mapping), 'maxErrorMetresXYZ': errors.tolist(), 'maxUVError': uv_error})
    result = {'files': report, 'trianglesChecked': sum(file['triangles'] for file in report), 'cornersChecked': sum(file['cornersChecked'] for file in report), 'maxErrorMetres': max(max(file['maxErrorMetresXYZ']) for file in report)}
    write_json(ARTIFACTS / 'geometry-audit.json', result)
    print(json.dumps(result, ensure_ascii=False), flush=True)


if __name__ == '__main__':
    audit() if '--audit' in sys.argv else prepare()
