import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFileSync, readdirSync } from 'node:fs';
import { dirname, resolve, relative } from 'node:path';
import { fileURLToPath } from 'node:url';
import { inflateSync } from 'node:zlib';
import { worldScenes } from '../src/world-scenes.js';

const root = fileURLToPath(new URL('../', import.meta.url));
const hash = value => createHash('sha256').update(value).digest('hex');
const json = path => JSON.parse(readFileSync(path, 'utf8'));
// Source downloads are deliberately excluded from Git. The optional provenance
// audit is run explicitly after prepare-world-scenes.py, never by npm test.
const auditOriginals = process.env.WORLD_SCENE_AUDIT_ORIGINALS === '1';

function gltf(bytes) {
  assert.equal(bytes.toString('ascii', 0, 4), 'b3dm');
  assert.equal(bytes.readUInt32LE(4), 1);
  assert.equal(bytes.readUInt32LE(8), bytes.length);
  const offset = 28 + [12, 16, 20, 24].reduce((sum, index) => sum + bytes.readUInt32LE(index), 0);
  assert.equal(bytes.toString('ascii', offset, offset + 4), 'glTF');
  assert.equal(bytes.readUInt32LE(offset + 4), 2);
  assert.equal(bytes.readUInt32LE(offset + 8), bytes.length - offset);
  const length = bytes.readUInt32LE(offset + 12);
  const document = JSON.parse(bytes.toString('utf8', offset + 20, offset + 20 + length));
  const binary = bytes.subarray(offset + 20 + length + 8);
  return { document, binary };
}

function accessor(document, binary, index) {
  const value = document.accessors[index];
  assert.equal(value.componentType, 5126);
  const view = document.bufferViews[value.bufferView];
  const size = { VEC2: 2, VEC3: 3 }[value.type];
  const start = (view.byteOffset || 0) + (value.byteOffset || 0);
  return new Float32Array(binary.buffer, binary.byteOffset + start, value.count * size);
}

function photograph(document, binary) {
  const view = document.bufferViews[document.images[0].bufferView];
  return binary.subarray(view.byteOffset || 0, (view.byteOffset || 0) + view.byteLength);
}

function jpegDimensions(bytes) {
  let offset = 2;
  while (offset + 4 < bytes.length) {
    assert.equal(bytes[offset], 0xff);
    while (bytes[offset] === 0xff) offset++;
    const marker = bytes[offset++];
    const length = bytes.readUInt16BE(offset);
    if ([0xc0, 0xc1, 0xc2].includes(marker)) return [bytes.readUInt16BE(offset + 5), bytes.readUInt16BE(offset + 3)];
    offset += length;
  }
  assert.fail('JPEG contains no supported frame dimensions');
}

function terrainPNG(bytes) {
  assert.equal(bytes.subarray(0, 8).toString('hex'), '89504e470d0a1a0a');
  let offset = 8;
  const compressed = [];
  while (offset + 12 <= bytes.length) {
    const length = bytes.readUInt32BE(offset);
    const type = bytes.toString('ascii', offset + 4, offset + 8);
    const data = bytes.subarray(offset + 8, offset + 8 + length);
    if (type === 'IHDR') {
      assert.equal(data.readUInt32BE(0), 256);
      assert.equal(data.readUInt32BE(4), 256);
      assert.equal(data[8], 8);
      assert.equal(data[9], 2, 'elevation uses lossless RGB without an alpha channel');
    }
    if (type === 'IDAT') compressed.push(data);
    offset += length + 12;
  }
  const rows = inflateSync(Buffer.concat(compressed));
  assert.equal(rows.length, 256 * (256 * 3 + 1));
  const rgb = Buffer.alloc(256 * 256 * 3);
  for (let row = 0; row < 256; row++) {
    const start = row * (256 * 3 + 1);
    assert.equal(rows[start], 0, 'prepared PNG uses ordinary unfiltered RGB scanlines');
    rows.copy(rgb, row * 256 * 3, start + 1, start + 1 + 256 * 3);
  }
  return rgb;
}

function geographic(x, y, z) {
  const a = 6378137;
  const eccentricity = 6.6943799901413165e-3;
  const p = Math.hypot(x, y);
  let latitude = Math.atan2(z, p * (1 - eccentricity));
  for (let i = 0; i < 8; i++) {
    const n = a / Math.sqrt(1 - eccentricity * Math.sin(latitude) ** 2);
    latitude = Math.atan2(z + eccentricity * n * Math.sin(latitude), p);
  }
  const n = a / Math.sqrt(1 - eccentricity * Math.sin(latitude) ** 2);
  return [Math.atan2(y, x) * 180 / Math.PI, latitude * 180 / Math.PI, p / Math.cos(latitude) - n];
}

function traverse(node, directory, seen = new Set()) {
  let meshes = 0;
  const uri = node.content?.uri || node.content?.url;
  if (uri) {
    assert.ok(!/^(?:https?:|\/)/.test(uri));
    const path = resolve(directory, uri);
    assert.ok(!relative(directory, path).startsWith('..'), 'model references stay inside the scene folder');
    assert.ok(!seen.has(path), 'each original source model is referenced once');
    seen.add(path);
    if (path.endsWith('.json')) meshes += traverse(json(path).root, dirname(path), seen);
    else { assert.ok(path.endsWith('.b3dm')); readFileSync(path); meshes++; }
  }
  for (const child of node.children || []) meshes += traverse(child, directory, seen);
  return meshes;
}

test('world 3D scenes are distinct licensed local datasets with real geographic coverage', () => {
  assert.ok(worldScenes.length >= 2);
  assert.equal(new Set(worldScenes.map(scene => scene.id)).size, worldScenes.length);
  for (const scene of worldScenes) {
    assert.ok(scene.id.startsWith('world-'));
    assert.ok(scene.placeId.startsWith('world-'));
    assert.ok(scene.country && scene.continent && scene.attribution && scene.scope);
    assert.ok(scene.sourceUrl.startsWith('https://') && scene.licenseUrl.startsWith('https://'));
    assert.ok(scene.center[0] >= scene.bounds[0] && scene.center[0] <= scene.bounds[2]);
    assert.ok(scene.center[1] >= scene.bounds[1] && scene.center[1] <= scene.bounds[3]);
    assert.ok(scene.zoom >= 15 && scene.zoom <= 19 && Number.isFinite(scene.elevation));
  }
});

test('Helsinki expansion covers four complete landmark areas within the new data budget', () => {
  const landmarks = [
    ['world-helsinki-uspenski-3d', [[24.96087, 60.16846]]],
    ['world-helsinki-market-square-3d', [[24.9547, 60.1673], [24.9565, 60.1680]]],
    ['world-helsinki-rock-church-3d', [[24.92517, 60.1731]]],
    ['world-helsinki-suomenlinna-3d', [[24.98569, 60.14531]]],
  ];
  let bytes = 0;
  for (const [id, coordinates] of landmarks) {
    const scene = worldScenes.find(value => value.id === id);
    assert.ok(scene, `${id} is registered`);
    const source = json(resolve(root, 'public', dirname(scene.url), 'source.json'));
    assert.equal(source.sourceLevel, 20);
    assert.match(source.archiveUrl, /^https:\/\/3d\.hel\.ninja\/.*Helsinki3D_2017_OBJ_\d{6}x2\.zip$/);
    assert.ok(scene.datumOffset < -17 && scene.datumOffset > -19, 'the EGM96 separation is applied when displaying the original ECEF heights');
    for (const [longitude, latitude] of coordinates) {
      assert.ok(longitude > source.bounds[0] && longitude < source.bounds[2]);
      assert.ok(latitude > source.bounds[1] && latitude < source.bounds[3]);
    }
    bytes += source.tileBytes;
  }
  assert.ok(bytes >= 100_000_000 && bytes <= 200_000_000);
});

const datasets = worldScenes.flatMap(scene => {
  const variants = [['mobile', scene.mobileUrl], ['tablet', scene.tabletUrl]].filter(([, url]) => url);
  return [scene, ...variants.filter(([, url], index) => variants.findIndex(value => value[1] === url) === index).map(([kind, url]) => ({ ...scene, id: scene.id.replace(/-3d$/, `-${kind}-3d`), name: `${scene.name}（${kind === 'tablet' ? 'iPad 摄影纹理适配' : '手机原生纹理层级'}）`, url }))];
});

for (const scene of datasets) {
  const directory = dirname(resolve(root, 'public', scene.url));
  const source = json(resolve(directory, 'source.json'));
  const tileset = json(resolve(root, 'public', scene.url));

  test(`${scene.name}: every model reference, SHA and declared byte count matches deployed data`, () => {
    assert.equal(source.id, scene.id);
    assert.equal(source.sourceUrl, scene.sourceUrl);
    assert.equal(source.licenseUrl, scene.licenseUrl);
    assert.equal(source.attribution, scene.attribution);
    assert.equal(traverse(tileset.root, directory), source.tileCount);
    assert.equal(source.files.length, source.tileCount);
    assert.ok(tileset.geometricError > 0 && tileset.root.geometricError > 0, 'the empty parent refines to its final source meshes');
    assert.equal(readdirSync(directory).filter(name => name.endsWith('.b3dm')).length, source.tileCount);
    let bytes = 0;
    for (const file of source.files) {
      const data = readFileSync(resolve(directory, file.path));
      assert.equal(data.length, file.bytes);
      assert.equal(hash(data), file.sha256);
      bytes += data.length;
    }
    assert.equal(bytes, source.tileBytes);
    assert.ok(bytes < 120_000_000);
  });

  test(`${scene.name}: deployed geometry, UVs and photographs match the source manifest`, () => {
    let triangles = 0;
    const sourceRoot = resolve(root, 'artifacts/world-scenes/helsinki-originals');
    const sourceFiles = new Map((source.sourceFiles || []).map(file => [file.path, file]));
    for (const file of source.files) {
      const { document, binary } = gltf(readFileSync(resolve(directory, file.path)));
      const primitive = document.meshes[0].primitives[0];
      assert.equal(primitive.mode, 4);
      const positions = accessor(document, binary, primitive.attributes.POSITION);
      const uv = accessor(document, binary, primitive.attributes.TEXCOORD_0);
      assert.ok(positions.every(Number.isFinite) && uv.every(Number.isFinite));
      assert.equal(positions.length / 9, file.triangles);
      assert.equal(positions.length / 3, uv.length / 2);
      triangles += file.triangles;
      const image = document.images[0];
      assert.equal(image.mimeType, 'image/jpeg');
      const jpeg = photograph(document, binary);
      assert.equal(jpeg.readUInt16BE(0), 0xffd8);
      assert.equal(hash(jpeg), file.photograph.sha256);
      assert.equal(jpeg.length, file.photograph.bytes);
      if (file.sourceOBJ && auditOriginals) {
        const original = readFileSync(resolve(sourceRoot, file.sourceOBJ));
        assert.equal(hash(original), sourceFiles.get(file.sourceOBJ).sha256);
        const lines = original.toString('utf8').split(/\r?\n/);
        const faces = lines.filter(line => line.startsWith('f '));
        assert.equal(faces.length, file.triangles);
        const coordinates = lines.filter(line => line.startsWith('vt ')).map(line => line.trim().split(/\s+/).slice(1).map(Number));
        let index = 0;
        for (const face of faces) {
          const corners = face.trim().split(/\s+/).slice(1);
          assert.equal(corners.length, 3, 'original source faces remain triangular without decimation');
          for (const corner of corners) {
            const originalUV = coordinates[Number(corner.split('/')[1]) - 1];
            assert.ok(Math.abs(uv[index++] - originalUV[0]) < 0.000001);
            assert.ok(Math.abs(uv[index++] - (1 - originalUV[1])) < 0.000001);
          }
        }
        const photographicPath = resolve(sourceRoot, dirname(file.sourceOBJ), file.photograph.source);
        assert.equal(hash(readFileSync(photographicPath)), source.textureVariant === 'tablet-resampled' ? file.photograph.originalSHA256 : hash(jpeg), 'the original official photograph remains traceable for every deployed texture');
      }
      if (file.sourceB3DM && auditOriginals) {
        const originalRoot = resolve(root, 'artifacts/world-scenes/lyon-originals');
        const original = readFileSync(resolve(originalRoot, file.sourceB3DM));
        assert.equal(hash(original), sourceFiles.get(file.sourceB3DM).sha256);
        const parsed = gltf(original);
        const originalPrimitive = parsed.document.meshes[0].primitives[0];
        const originalPositions = accessor(parsed.document, parsed.binary, originalPrimitive.attributes.POSITION);
        const originalUV = accessor(parsed.document, parsed.binary, originalPrimitive.attributes.TEXCOORD_0);
        assert.equal(positions.length, originalPositions.length, 'all original triangle vertices survive reprojection');
        assert.deepEqual(uv, originalUV, 'original glTF UVs are retained without rounding or vertical flipping');
        assert.equal(hash(readFileSync(resolve(originalRoot, file.photograph.source))), hash(jpeg));
      }
    }
    assert.equal(triangles, source.triangleCount);
  });

  test(`${scene.name}: double precision placement and vertical datum keep finite real-world coordinates`, () => {
    assert.deepEqual(source.bounds, scene.bounds);
    assert.equal(tileset.asset.gltfUpAxis, 'Y');
    const matrix = tileset.root.transform;
    assert.equal(matrix.length, 16);
    assert.ok(matrix.every(Number.isFinite));
    assert.ok(Math.hypot(...matrix.slice(12, 15)) > 6_000_000, 'ECEF origin remains double precision in the tileset');
    const center = geographic(...matrix.slice(12, 15));
    const frameCenter = source.frameCenter || source.center;
    assert.ok(Math.abs(center[0] - frameCenter[0]) < 1e-9 && Math.abs(center[1] - frameCenter[1]) < 1e-9);
    for (let column = 0; column < 3; column++) assert.ok(Math.abs(Math.hypot(...matrix.slice(column * 4, column * 4 + 3)) - 1) < 1e-12);
    assert.ok(source.verticalDatum && source.conversion);
    if (scene.country === '芬兰') {
      assert.equal(source.sourceCRS, 'EPSG:3879+5773');
      assert.deepEqual(source.sourceOrigin, [25490000, 6668000, 0]);
      assert.equal(source.captureYear, 2017);
      assert.equal(source.license, 'CC BY 4.0');
      assert.ok(source.verticalDatum.includes('EGM96'));
      assert.match(source.geoid.sha256, /^[a-f0-9]{64}$/);
      assert.equal(source.geoid.url, 'https://cdn.proj.org/us_nga_egm96_15.tif');
      if (auditOriginals) assert.equal(hash(readFileSync(resolve(root, 'artifacts/world-scenes/us_nga_egm96_15.tif'))), source.geoid.sha256);
    }
    if (scene.country === '法国') {
      assert.equal(source.kind, 'reconstruction');
      assert.equal(scene.kind, source.kind);
      assert.equal(source.sourceCRS, 'EPSG:3946');
      assert.equal(source.license, 'Licence Ouverte 2.0');
      assert.ok(source.buildingIds.includes('69381AS18'), 'the source model contains Lyon City Hall');
      assert.ok(source.verticalDatum.includes('assumed'), 'the source vertical CRS limitation is stated explicitly');
      assert.ok(scene.terrain, 'absolute city elevations use terrain behind the buildings');
      assert.match(source.geoid.sha256, /^[a-f0-9]{64}$/);
      if (auditOriginals) assert.equal(hash(readFileSync(resolve(root, 'artifacts/world-scenes/fr_ign_RAF18.tif'))), source.geoid.sha256);
    }
    const [west, south, east, north] = scene.bounds;
    for (const file of source.files) {
      assert.ok(file.maxFloat32RoundingErrorMetres < 0.0001, 'local floating point coordinates retain sub-millimetre precision');
      const { document, binary } = gltf(readFileSync(resolve(directory, file.path)));
      const positions = accessor(document, binary, document.meshes[0].primitives[0].attributes.POSITION);
      for (let index = 0; index < positions.length; index += Math.max(3, Math.floor(positions.length / 36) * 3)) {
        // The glTF Y-up-to-Z-up conversion is [x, -z, y].
        const [x, y, z] = [positions[index], -positions[index + 2], positions[index + 1]];
        const world = [0, 1, 2].map(row => matrix[row] * x + matrix[4 + row] * y + matrix[8 + row] * z + matrix[12 + row]);
        const point = geographic(...world);
        assert.ok(point[0] >= west - 0.000001 && point[0] <= east + 0.000001);
        assert.ok(point[1] >= south - 0.000001 && point[1] <= north + 0.000001);
        assert.ok(point[2] >= source.heightRangeEllipsoidal[0] - 0.01 && point[2] <= source.heightRangeEllipsoidal[1] + 0.01);
      }
    }
  });
}

for (const scene of worldScenes.filter(scene => scene.tabletUrl && scene.tabletUrl !== scene.mobileUrl)) {
  test(`${scene.name}: iPad photographs fit the texture budget while every geometry and UV byte stays identical`, () => {
    const desktopDirectory = dirname(resolve(root, 'public', scene.url));
    const tabletDirectory = dirname(resolve(root, 'public', scene.tabletUrl));
    const desktop = json(resolve(desktopDirectory, 'source.json'));
    const tablet = json(resolve(tabletDirectory, 'source.json'));
    assert.equal(tablet.variantOf, scene.id);
    assert.equal(tablet.textureVariant, 'tablet-resampled');
    assert.match(tablet.textureResampling, /LANCZOS.*quality 95/);
    assert.deepEqual(tablet.blocks, desktop.blocks);
    assert.deepEqual(tablet.bounds, desktop.bounds);
    assert.deepEqual(tablet.heightRangeEllipsoidal, desktop.heightRangeEllipsoidal);
    assert.deepEqual(json(resolve(tabletDirectory, 'tileset.json')), json(resolve(desktopDirectory, 'tileset.json')));
    assert.equal(tablet.triangleCount, desktop.triangleCount);
    assert.equal(tablet.files.length, desktop.files.length);
    let rgbaBytes = 0;
    for (const [index, file] of tablet.files.entries()) {
      const original = desktop.files[index];
      assert.equal(file.path, original.path);
      assert.equal(file.photograph.originalSHA256, original.photograph.sha256);
      const desktopModel = gltf(readFileSync(resolve(desktopDirectory, original.path)));
      const tabletModel = gltf(readFileSync(resolve(tabletDirectory, file.path)));
      for (const attribute of ['POSITION', 'TEXCOORD_0']) {
        const originalData = accessor(desktopModel.document, desktopModel.binary, desktopModel.document.meshes[0].primitives[0].attributes[attribute]);
        const tabletData = accessor(tabletModel.document, tabletModel.binary, tabletModel.document.meshes[0].primitives[0].attributes[attribute]);
        assert.deepEqual(Buffer.from(tabletData.buffer, tabletData.byteOffset, tabletData.byteLength), Buffer.from(originalData.buffer, originalData.byteOffset, originalData.byteLength));
      }
      const dimensions = jpegDimensions(photograph(tabletModel.document, tabletModel.binary));
      assert.deepEqual(dimensions, file.photograph.dimensions);
      assert.ok(dimensions.every(value => value <= tablet.textureMaxDimension));
      const originalDimensions = jpegDimensions(photograph(desktopModel.document, desktopModel.binary));
      assert.deepEqual(originalDimensions, file.photograph.originalDimensions);
      if (Math.max(...originalDimensions) <= tablet.textureMaxDimension) assert.equal(file.photograph.sha256, original.photograph.sha256, 'already small photographs retain the exact source JPEG bytes');
      rgbaBytes += dimensions[0] * dimensions[1] * 4;
    }
    assert.equal(rgbaBytes, tablet.textureRGBABytes);
    assert.ok(rgbaBytes <= 250 * 1024 ** 2);
  });
}

for (const scene of worldScenes.filter(scene => scene.mobileUrl)) {
  test(`${scene.name}: native mobile textures reduce decoded memory while every geometry byte stays identical`, () => {
    const desktopDirectory = dirname(resolve(root, 'public', scene.url));
    const mobileDirectory = dirname(resolve(root, 'public', scene.mobileUrl));
    const desktop = json(resolve(desktopDirectory, 'source.json'));
    const mobile = json(resolve(mobileDirectory, 'source.json'));
    assert.equal(mobile.variantOf, scene.id);
    assert.deepEqual(mobile.sourceClusters, desktop.sourceClusters);
    assert.deepEqual(mobile.buildingIds, desktop.buildingIds);
    assert.deepEqual(mobile.bounds, desktop.bounds);
    assert.deepEqual(mobile.heightRangeEllipsoidal, desktop.heightRangeEllipsoidal);
    assert.deepEqual(json(resolve(mobileDirectory, 'tileset.json')).root.transform, json(resolve(desktopDirectory, 'tileset.json')).root.transform);
    assert.equal(mobile.triangleCount, desktop.triangleCount);
    assert.ok(mobile.tileBytes < desktop.tileBytes / 3);
    let rgbaBytes = 0;
    for (const [index, file] of mobile.files.entries()) {
      assert.equal(file.sourceCluster, desktop.sourceClusters[index]);
      const desktopModel = gltf(readFileSync(resolve(desktopDirectory, desktop.files[index].path)));
      const mobileModel = gltf(readFileSync(resolve(mobileDirectory, file.path)));
      const desktopPositions = accessor(desktopModel.document, desktopModel.binary, desktopModel.document.meshes[0].primitives[0].attributes.POSITION);
      const mobilePositions = accessor(mobileModel.document, mobileModel.binary, mobileModel.document.meshes[0].primitives[0].attributes.POSITION);
      assert.deepEqual(Buffer.from(mobilePositions.buffer, mobilePositions.byteOffset, mobilePositions.byteLength), Buffer.from(desktopPositions.buffer, desktopPositions.byteOffset, desktopPositions.byteLength));
      const dimensions = jpegDimensions(photograph(mobileModel.document, mobileModel.binary));
      assert.deepEqual(dimensions, file.photograph.dimensions);
      assert.ok(dimensions.every(value => value <= 2048));
      rgbaBytes += dimensions[0] * dimensions[1] * 4;
      assert.ok(mobile.sourceFiles.some(original => original.path === file.photograph.source && original.sha256 === file.photograph.sha256), 'the native lower-LOD JPEG is embedded without another resize or recompression');
    }
    assert.equal(rgbaBytes, mobile.textureRGBABytes);
    assert.ok(rgbaBytes <= 96 * 1024 ** 2);
  });
}

for (const scene of worldScenes.filter(scene => scene.terrainSource)) {
  const directory = resolve(root, 'public', dirname(scene.terrainSource.tiles[0]), '../..');
  const source = json(resolve(directory, 'source.json'));
  const pixels = new Map();

  test(`${scene.name}: local official ground is complete and keeps the original fallback data`, () => {
    assert.equal(scene.terrainSource.type, 'raster-dem');
    assert.equal(scene.terrainSource.tileSize, 256);
    assert.equal(scene.terrainSource.encoding, 'terrarium');
    assert.equal(scene.terrainSource.minzoom, 14);
    assert.equal(scene.terrainSource.maxzoom, 14);
    assert.deepEqual(scene.terrainSource.bounds, source.bounds);
    assert.equal(source.sourceCRS, 'EPSG:3946');
    assert.equal(source.sourceTriangleCount, 95391);
    assert.equal(source.license, 'Licence Ouverte 2.0');
    assert.equal(source.files.length, 9);
    assert.ok(source.officialTINPixels > 30000);
    assert.equal(source.officialTINPixels + source.fallbackPixels, 9 * 256 ** 2);
    assert.ok(source.maxEncodingErrorMetres <= 1 / 256);
    for (const fallback of source.fallbacks) assert.equal(hash(readFileSync(resolve(root, 'public', fallback.localPath))), fallback.sha256, 'the original Mapzen cache was not modified');
    for (const file of source.files) {
      const data = readFileSync(resolve(directory, file.path));
      assert.equal(data.length, file.bytes);
      assert.equal(hash(data), file.sha256);
      const rgb = terrainPNG(data);
      assert.equal(hash(rgb), file.rgbSHA256);
      pixels.set(file.path.replace(/\.png$/, ''), rgb);
      for (const sample of file.fallbackSamples) {
        const start = (sample.pixel[1] * 256 + sample.pixel[0]) * 3;
        assert.deepEqual([...rgb.subarray(start, start + 3)], sample.rgb);
      }
    }
  });

  test(`${scene.name}: ground pixels reproduce the actual CityGML triangles within Terrarium precision`, () => {
    assert.ok(source.validationSamples.length >= 30);
    for (const sample of source.validationSamples) {
      const [a, b, c] = sample.sourceTriangle;
      const [x, y] = sample.cc46;
      const determinant = (b[0] - a[0]) * (c[1] - a[1]) - (c[0] - a[0]) * (b[1] - a[1]);
      const u = ((x - a[0]) * (c[1] - a[1]) - (c[0] - a[0]) * (y - a[1])) / determinant;
      const v = ((b[0] - a[0]) * (y - a[1]) - (x - a[0]) * (b[1] - a[1])) / determinant;
      assert.ok(u >= -1e-8 && v >= -1e-8 && u + v <= 1 + 1e-8);
      const expected = (1 - u - v) * a[2] + u * b[2] + v * c[2];
      assert.ok(Math.abs(expected - sample.sourceHeightMetres) < 1e-9);
      const rgb = pixels.get(sample.tile) || terrainPNG(readFileSync(resolve(directory, sample.tile + '.png')));
      const start = (sample.pixel[1] * 256 + sample.pixel[0]) * 3;
      const decoded = rgb[start] * 256 + rgb[start + 1] + rgb[start + 2] / 256 - 32768;
      assert.equal(decoded, sample.encodedHeightMetres);
      assert.ok(Math.abs(decoded - expected) <= 1 / 256);
      const [zoom, tileX, tileY] = sample.tile.split('/').map(Number);
      const lon = (tileX + (sample.pixel[0] + .5) / 256) / 2 ** zoom * 360 - 180;
      const lat = Math.atan(Math.sinh(Math.PI * (1 - 2 * (tileY + (sample.pixel[1] + .5) / 256) / 2 ** zoom))) * 180 / Math.PI;
      assert.ok(Math.abs(lon - sample.coordinate[0]) < 1e-12 && Math.abs(lat - sample.coordinate[1]) < 1e-12);
    }
    const cityHall = source.validationSamples.find(sample => sample.label === '市政厅中心');
    assert.ok(cityHall.encodedHeightMetres > 168 && cityHall.encodedHeightMetres < 170);
    assert.ok(cityHall.previousMapzenHeightMetres - cityHall.encodedHeightMetres > 15);
    if (auditOriginals) {
      const original = readFileSync(resolve(root, 'artifacts/world-scenes/lyon-originals', 'LYON_1ER_TIN_2018.gml'));
      assert.equal(original.length, source.sourceBytes);
      assert.equal(hash(original), source.sourceSHA256);
      const required = new Map(source.validationSamples.map(sample => [sample.sourceTriangleIndex, sample.sourceTriangle]));
      let index = 0;
      for (const match of original.toString('utf8').matchAll(/<gml:posList>([^<]+)<\/gml:posList>/g)) {
        if (required.has(index)) {
          const values = match[1].trim().split(/\s+/).map(Number);
          assert.deepEqual([values.slice(0, 3), values.slice(3, 6), values.slice(6, 9)], required.get(index));
          required.delete(index);
        }
        index++;
      }
      assert.equal(index, source.sourceTriangleCount);
      assert.equal(required.size, 0);
    }
  });
}
