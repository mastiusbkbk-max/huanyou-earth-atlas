import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFileSync, readdirSync } from 'node:fs';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = fileURLToPath(new URL('../', import.meta.url));
const json = path => JSON.parse(readFileSync(path, 'utf8'));
const hash = data => createHash('sha256').update(data).digest('hex');
const definitions = [
  { key: 'melbourne-flinders', blocks: 2, endpoints: [[144.9649, -37.8183], [144.9685, -37.8183]] },
  { key: 'melbourne-exhibition', blocks: 2, endpoints: [[144.9699, -37.8047], [144.9730, -37.8047]] },
  { key: 'melbourne-shrine', blocks: 1, endpoints: [[144.9730, -37.8308], [144.9740, -37.8301]] },
];

function decode(data) {
  assert.equal(data.toString('ascii', 0, 4), 'b3dm');
  assert.equal(data.readUInt32LE(8), data.length);
  const offset = 28 + [12, 16, 20, 24].reduce((sum, index) => sum + data.readUInt32LE(index), 0);
  assert.equal(data.toString('ascii', offset, offset + 4), 'glTF');
  const length = data.readUInt32LE(offset + 12);
  const document = JSON.parse(data.toString('utf8', offset + 20, offset + 20 + length));
  const binary = data.subarray(offset + 28 + length);
  const image = document.bufferViews[document.images[0].bufferView];
  return { document, binary, photograph: binary.subarray(image.byteOffset, image.byteOffset + image.byteLength) };
}

function jpegDimensions(bytes) {
  let offset = 2;
  assert.equal(bytes.readUInt16BE(0), 0xffd8);
  while (offset + 4 < bytes.length) {
    assert.equal(bytes[offset], 0xff);
    while (bytes[offset] === 0xff) offset++;
    const marker = bytes[offset++];
    const length = bytes.readUInt16BE(offset);
    if ([0xc0, 0xc1, 0xc2].includes(marker)) return [bytes.readUInt16BE(offset + 5), bytes.readUInt16BE(offset + 3)];
    offset += length;
  }
  assert.fail('photographic JPEG must have frame dimensions');
}

for (const definition of definitions) {
  const directory = resolve(root, 'public/models/world-' + definition.key);
  const source = json(resolve(directory, 'source.json'));
  const tileset = json(resolve(directory, 'tileset.json'));

  test(`${source.title}: official capture, original CRS and complete landmark coverage are explicit`, () => {
    assert.equal(source.id, 'world-' + definition.key + '-3d');
    assert.equal(source.publisher, 'City of Melbourne');
    assert.equal(source.captureYear, 2018);
    assert.equal(source.license, 'CC BY 4.0');
    assert.equal(source.licenseUrl, 'https://creativecommons.org/licenses/by/4.0/legalcode');
    assert.equal(source.sourceCRS, 'EPSG:28355+5773');
    assert.deepEqual(source.sourceOrigin, [319000, 5813000, 0]);
    assert.equal(source.sourceLevel, 20);
    assert.equal(source.blocks.length, definition.blocks);
    assert.match(source.verticalDatum, /EGM96/);
    assert.match(source.verticalDatum, /AHD/);
    assert.match(source.verticalDatum, /conflict/);
    assert.match(source.conversion, /without decimation/);
    assert.ok(source.sourceFiles.some(file => file.path.endsWith('/metadata.xml')));
    for (const [lon, lat] of [source.center, ...definition.endpoints]) {
      assert.ok(lon >= source.bounds[0] && lon <= source.bounds[2]);
      assert.ok(lat >= source.bounds[1] && lat <= source.bounds[3]);
    }
    assert.equal(tileset.asset.gltfUpAxis, 'Y');
    assert.ok(Math.hypot(...tileset.root.transform.slice(12, 15)) > 6_000_000);
  });

  test(`${source.title}: local payloads preserve high detail with a measured texture upload budget`, () => {
    assert.equal(tileset.root.children.length, source.tileCount);
    assert.equal(source.files.length, source.tileCount);
    assert.equal(readdirSync(directory).filter(name => name.endsWith('.b3dm')).length, source.tileCount);
    let totalBytes = 0, triangles = 0, rgba = 0;
    for (const file of source.files) {
      assert.ok(tileset.root.children.some(child => child.content.uri === file.path));
      const data = readFileSync(resolve(directory, file.path));
      assert.equal(data.length, file.bytes);
      assert.equal(hash(data), file.sha256);
      totalBytes += data.length;
      const { document, photograph } = decode(data);
      const primitive = document.meshes[0].primitives[0];
      assert.equal(primitive.mode, 4);
      const count = document.accessors[primitive.attributes.POSITION].count;
      assert.equal(count / 3, file.triangles);
      assert.equal(document.accessors[primitive.attributes.TEXCOORD_0].count, count);
      triangles += file.triangles;
      assert.equal(hash(photograph), file.photograph.sha256);
      assert.equal(photograph.length, file.photograph.bytes);
      const dimensions = jpegDimensions(photograph);
      assert.deepEqual(dimensions, file.photograph.dimensions);
      assert.ok(dimensions.every(value => value <= 4096));
      assert.ok(file.photograph.originalDimensions.every((value, index) => value >= dimensions[index]));
      rgba += dimensions[0] * dimensions[1] * 4;
      assert.ok(source.sourceFiles.some(original => original.sha256 === file.photograph.originalSHA256));
    }
    assert.equal(totalBytes, source.tileBytes);
    assert.equal(triangles, source.triangleCount);
    assert.ok(triangles > 300_000, 'these are original dense photography surfaces');
    assert.equal(rgba, source.textureRGBABytes);
    assert.ok(rgba <= 256 * 1024 ** 2, 'the published total upload budget includes every material');
    assert.ok(totalBytes < 120_000_000);
  });
}

if (process.env.LANDMARK_SCENE_AUDIT_ORIGINALS === '1') {
  test('downloaded original L20 triangles, UV mapping and photography match every deployed source claim', () => {
    for (const definition of definitions) {
      const directory = resolve(root, 'public/models/world-' + definition.key);
      const source = json(resolve(directory, 'source.json'));
      const originals = resolve(root, 'artifacts/landmark-scenes/originals');
      for (const file of source.sourceFiles) {
        const data = readFileSync(resolve(originals, file.path));
        assert.equal(data.length, file.bytes);
        assert.equal(hash(data), file.sha256);
      }
      for (const mesh of new Set(source.files.map(file => file.sourceMesh))) {
        const uv = [], faces = new Map();
        let material;
        for (const line of readFileSync(resolve(originals, mesh), 'utf8').split(/\r?\n/)) {
          const columns = line.trim().split(/\s+/);
          if (columns[0] === 'vt') uv.push(columns.slice(1, 3).map(Number));
          if (columns[0] === 'usemtl') { material = columns[1]; faces.set(material, faces.get(material) || []); }
          if (columns[0] === 'f') {
            assert.equal(columns.length, 4);
            for (const corner of columns.slice(1)) faces.get(material).push(Number(corner.split('/')[1]) - 1);
          }
        }
        for (const file of source.files.filter(file => file.sourceMesh === mesh)) {
          const corners = faces.get(file.sourceMaterial);
          assert.equal(corners.length / 3, file.triangles);
          const { document, binary } = decode(readFileSync(resolve(directory, file.path)));
          const accessor = document.accessors[document.meshes[0].primitives[0].attributes.TEXCOORD_0];
          const view = document.bufferViews[accessor.bufferView];
          for (let index = 0; index < corners.length; index++) {
            assert.ok(Math.abs(binary.readFloatLE(view.byteOffset + index * 8) - uv[corners[index]][0]) < 1e-6);
            assert.ok(Math.abs(binary.readFloatLE(view.byteOffset + index * 8 + 4) - (1 - uv[corners[index]][1])) < 1e-6);
          }
        }
      }
    }
  });
}
