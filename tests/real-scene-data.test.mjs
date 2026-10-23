import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { dirname, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { realScenes } from '../src/real-scene.js';

const json = path => JSON.parse(readFileSync(path, 'utf8'));

function nodes(root, visit, depth = 0) {
  visit(root, depth);
  for (const child of root.children || []) nodes(child, visit, depth + 1);
}

function b3dmModel(payload, path) {
  assert.equal(payload.toString('ascii', 0, 4), 'b3dm', path);
  assert.equal(payload.readUInt32LE(4), 1, path);
  assert.equal(payload.readUInt32LE(8), payload.length, path);
  const glb = 28 + [12, 16, 20, 24].reduce((sum, offset) => sum + payload.readUInt32LE(offset), 0);
  assert.equal(payload.toString('ascii', glb, glb + 4), 'glTF', path);
  assert.equal(payload.readUInt32LE(glb + 4), 2, path);
  assert.ok(glb + payload.readUInt32LE(glb + 8) <= payload.length);
  assert.equal(payload.readUInt32LE(glb + 16), 0x4e4f534a);
  const length = payload.readUInt32LE(glb + 12);
  const model = JSON.parse(payload.toString('utf8', glb + 20, glb + 20 + length).replace(/\0+$/, ''));
  assert.equal(payload.readUInt32LE(glb + 24 + length), 0x004e4942);
  const featureLength = payload.readUInt32LE(12);
  const featureTable = JSON.parse(payload.toString('utf8', 28, 28 + featureLength).trim().replace(/\0+$/, ''));
  return { model, binaryStart: glb + 28 + length, featureTable };
}

for (const scene of realScenes) {
  const directory = dirname(resolve(fileURLToPath(new URL('../public/', import.meta.url)), scene.url));
  const source = json(resolve(directory, 'source.json'));
  const top = json(resolve(directory, 'tileset.json'));
  const parts = source.collection ? source.sourceParts.map(part => ({
    directory: resolve(directory, part.directory),
    source: json(resolve(directory, part.sourcePath)),
    top: json(resolve(directory, part.directory, 'tileset.json')),
  })) : [{ directory, source, top }];

  test(`${scene.name}: complete local references retain every original mesh root`, () => {
    const documents = new Set();
    const tiles = new Set();
    const nativeRoots = new Set(source.roots.map(root => resolve(directory, root.path)));
    const indexFiles = new Map((source.indexFiles || []).map(file => [resolve(directory, file.path), file]));
    function inspect(path, sourceDepth = null) {
      if (documents.has(path)) return;
      documents.add(path);
      const document = json(path);
      const retained = indexFiles.get(path);
      assert.equal(document.asset.version, retained ? '0.0' : '1.0');
      assert.equal(document.asset.gltfUpAxis, 'Z');
      if (retained) {
        assert.equal(retained.retainedDepth, sourceDepth);
        assert.match(retained.sourceSha256, /^[a-f0-9]{64}$/);
        assert.equal(createHash('sha256').update(readFileSync(path)).digest('hex'), retained.localSha256);
      }
      nodes(document.root, (node, depth) => {
        if (sourceDepth !== null) assert.ok(sourceDepth + depth <= source.lodStrategy.maxTreeDepth);
        const uri = node.content?.uri || node.content?.url;
        if (!uri) return;
        assert.ok(!/^(?:[a-z]+:|\/|\\)/i.test(uri), `external content: ${uri}`);
        const target = resolve(dirname(path), uri);
        assert.ok(target.startsWith(directory + sep), `content escapes model directory: ${uri}`);
        assert.ok(statSync(target).isFile(), `missing content: ${uri}`);
        if (target.endsWith('.json')) inspect(target, nativeRoots.has(target) ? 0 : sourceDepth === null ? null : sourceDepth + depth);
        else {
          assert.ok(target.endsWith('.b3dm'));
          tiles.add(target);
        }
      });
    }
    inspect(resolve(directory, 'tileset.json'));
    assert.ok(source.sourceRootCount > 0);
    assert.equal(source.sourceRootCount, source.roots.length);
    assert.equal(top.root.children.length, source.collection ? parts.length : source.sourceRootCount);
    for (const part of parts) assert.equal(part.top.root.children.length, part.source.sourceRootCount);
    assert.equal(documents.size, source.indexFiles ? source.indexFiles.length + 1 : source.sourceRootCount + 1 + (source.collection ? parts.length : 0));
    for (const root of nativeRoots) assert.ok(documents.has(root), `unreachable original root: ${root}`);
    for (const path of indexFiles.keys()) assert.ok(documents.has(path), `unreachable retained index: ${path}`);
    assert.equal(tiles.size, source.tileCount);
    assert.deepEqual(tiles, new Set(source.files.map(file => resolve(directory, file.path))));
    if (source.collection) {
      assert.deepEqual(source.files, parts.flatMap(part => part.source.files.map(file => ({
        ...file, path: `${part.source.sheet}/${file.path}`,
      }))));
      assert.deepEqual(source.roots, parts.flatMap(part => part.source.roots.map(root => ({
        ...root, path: `${part.source.sheet}/${root.path}`,
      }))));
    }
  });

  test(`${scene.name}: verified source bytes contain embedded meshes and photography`, () => {
    let bytes = 0;
    for (const file of source.files) {
      const payload = readFileSync(resolve(directory, file.path));
      assert.equal(payload.length, file.bytes, file.path);
      assert.equal(createHash('sha256').update(payload).digest('hex'), file.sha256, file.path);
      const { model, binaryStart } = b3dmModel(payload, file.path);
      assert.ok(model.meshes?.length > 0, `missing real mesh: ${file.path}`);
      assert.ok(model.textures?.length > 0 && model.images?.length > 0, `missing photography: ${file.path}`);
      for (const mesh of model.meshes) {
        assert.ok(mesh.primitives.length > 0);
        for (const primitive of mesh.primitives) assert.ok(Number.isInteger(primitive.attributes.POSITION));
      }
      for (const buffer of model.buffers || []) assert.equal(buffer.uri, undefined, `external buffer: ${file.path}`);
      for (const image of model.images) {
        assert.equal(image.uri, undefined, `external texture: ${file.path}`);
        assert.ok(Number.isInteger(image.bufferView));
        assert.match(image.mimeType, /^image\/(?:jpeg|png|ktx2)$/);
        const view = model.bufferViews[image.bufferView];
        assert.equal(view.buffer, 0);
        assert.ok(view.byteLength > 0 && binaryStart + (view.byteOffset || 0) + view.byteLength <= payload.length);
        const start = binaryStart + (view.byteOffset || 0);
        if (image.mimeType === 'image/ktx2') {
          assert.equal(payload.subarray(start, start + 12).toString('hex'), 'ab4b5458203230bb0d0a1a0a');
          assert.ok(payload.readUInt32LE(start + 20) > 0 && payload.readUInt32LE(start + 24) > 0);
          assert.ok(model.extensionsUsed.includes('KHR_texture_basisu'));
          assert.ok(model.textures.some(texture => texture.extensions?.KHR_texture_basisu?.source === model.images.indexOf(image)));
        } else if (image.mimeType === 'image/jpeg') {
          assert.equal(payload.readUInt16BE(start), 0xffd8);
        } else {
          assert.equal(payload.subarray(start, start + 8).toString('hex'), '89504e470d0a1a0a');
        }
      }
      bytes += payload.length;
    }
    assert.equal(source.files.length, source.tileCount);
    assert.equal(bytes, source.tileBytes);
    assert.ok(bytes > 0 && bytes <= 150 * 1024 * 1024);
  });

  test(`${scene.name}: declared coverage preserves all original ECEF transforms`, () => {
    const [west, south, east, north] = source.bounds;
    assert.equal(source.bounds.length, 4);
    assert.ok(west < east && south < north);
    source.bounds.forEach((value, index) => assert.ok(Math.abs(value - scene.bounds[index]) < 1e-6));
    assert.deepEqual(source.center, scene.center);
    assert.ok(source.center[0] > west && source.center[0] < east);
    assert.ok(source.center[1] > south && source.center[1] < north);
    source.bounds.forEach((value, index) => {
      assert.ok(Math.abs(top.root.boundingVolume.region[index] - value * Math.PI / 180) < 1e-14);
    });
    for (const original of source.roots) {
      assert.match(original.sourceSha256, /^[a-f0-9]{64}$/);
      if (source.indexFiles) assert.equal(source.indexFiles.find(file => file.path === original.path).sourceSha256, original.sourceSha256);
      const document = json(resolve(directory, original.path));
      assert.deepEqual(document.root.transform, original.transform);
      assert.deepEqual(document.root.boundingVolume, original.boundingVolume);
      if (original.transform) assert.deepEqual(original.transform.slice(0, 12), [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0]);
      else assert.ok(source.indexFiles, 'Missing transform is only valid for the documented legacy ECEF source');
      const part = parts.find(part => resolve(directory, original.path).startsWith(part.directory + sep));
      const child = part.top.root.children.find(node => resolve(part.directory, node.content.uri) === resolve(directory, original.path));
      assert.ok(child);
      const sphere = original.boundingVolume.sphere;
      assert.deepEqual(child.boundingVolume.sphere,
        original.transform ? [0, 1, 2].map(index => sphere[index] + original.transform[12 + index]).concat(sphere[3]) : sphere);
      const [x, y, z] = child.boundingVolume.sphere;
      const longitude = Math.atan2(y, x) * 180 / Math.PI;
      const latitude = Math.atan2(z, Math.hypot(x, y) * (1 - 0.00669437999014)) * 180 / Math.PI;
      assert.ok(longitude > west - .002 && longitude < east + .002);
      assert.ok(latitude > south - .002 && latitude < north + .002);
    }
    if (source.indexFiles) {
      // Legacy tiles store absolute ECEF in RTC_CENTER and an ENU rotation in
      // glTF, rather than the modern root.transform used by the other sheets.
      for (const file of source.files) {
        const { model, featureTable } = b3dmModel(readFileSync(resolve(directory, file.path)), file.path);
        const rtc = featureTable.RTC_CENTER;
        assert.equal(rtc.length, 3);
        assert.ok(rtc.every(Number.isFinite) && Math.hypot(...rtc) > 6e6);
        for (const node of model.nodes.filter(node => Number.isInteger(node.mesh))) {
          const matrix = node.matrix;
          assert.equal(matrix.length, 16);
          assert.deepEqual(matrix.slice(12), [0, 0, 0, 1]);
          for (let column = 0; column < 3; column++) {
            assert.ok(Math.abs(Math.hypot(...matrix.slice(column * 4, column * 4 + 3)) - 1) < 1e-10);
          }
          for (const primitive of model.meshes[node.mesh].primitives) {
            const accessor = model.accessors[primitive.attributes.POSITION];
            assert.ok(accessor.count > 0 && accessor.min.length === 3 && accessor.max.length === 3);
            for (let corner = 0; corner < 8; corner++) {
              const local = [0, 1, 2].map(axis => (corner & (1 << axis) ? accessor.max : accessor.min)[axis]);
              const [x, y, z] = rtc.map((value, row) => value + local.reduce((sum, coordinate, column) => sum + coordinate * matrix[column * 4 + row], 0));
              const longitude = Math.atan2(y, x) * 180 / Math.PI;
              const latitude = Math.atan2(z, Math.hypot(x, y) * (1 - 0.00669437999014)) * 180 / Math.PI;
              // Accessor AABB corners conservatively enclose the decoded mesh;
              // five metres also covers quantization and this ECEF conversion.
              assert.ok(longitude > west - .00005 && longitude < east + .00005, `${file.path}: original mesh longitude`);
              assert.ok(latitude > south - .00005 && latitude < north + .00005, `${file.path}: original mesh latitude`);
            }
          }
        }
      }
    }
  });

  test(`${scene.name}: source states licence, revision, limited coverage and exact local size`, () => {
    assert.equal(source.datasetId, 'landsd_rcd_1671677054006_62261');
    assert.equal(source.sheet, scene.sheet);
    const coverageTitle = source.collection ? '双图幅' : source.selectedSourceRoots ? '局部网格' : '单网格';
    assert.equal(source.title.replaceAll(' ', ''), `${scene.name.replaceAll(' ', '')}实景三维（${coverageTitle}）`);
    for (const sheet of source.sheets || [scene.sheet]) assert.ok(decodeURIComponent(source.recordQueryUrl).includes(sheet));
    assert.match(source.attribution, /地政总署/);
    assert.match(source.attribution, /CSDI/);
    assert.match(source.ownership, /知识产权归香港特别行政区政府/);
    assert.match(source.processing, /原B3DM字节.*未改/);
    assert.equal(source.licenseUrl, 'https://portal.csdi.gov.hk/csdi-webpage/doc/TNC');
    assert.equal(source.licenseUrl, scene.licenseUrl);
    assert.equal(source.productUrl, scene.sourceUrl);
    assert.equal(source.sourceRevisionDate, new Intl.DateTimeFormat('en-CA', { timeZone: source.revisionDateTimezone, year: 'numeric', month: '2-digit', day: '2-digit' }).format(source.sourceRevisionTimestamp));
    assert.match(source.coverageNote, /not all of Hong Kong/);
    assert.equal(source.lodStrategy.allOriginalRootsRetained, !source.selectedSourceRoots);
    if (source.selectedSourceRoots) {
      assert.ok(source.originalSourceRootCount > source.sourceRootCount);
      assert.equal(source.selectedSourceRoots.length, source.sourceRootCount);
      assert.deepEqual(new Set(source.roots.map(root => root.path.split('/')[0])), new Set(source.selectedSourceRoots));
      assert.equal(source.lodStrategy.selectedSourceDepth, 3);
      assert.equal(source.lodStrategy.maxTreeDepth, 0);
      assert.equal(source.lodStrategy.sourceRootBoundsRetained, true);
      assert.equal(source.lodStrategy.externalIndexTreeRetained, false);
      assert.equal(source.tileCount, source.sourceRootCount);
      for (const index of source.indexFiles) {
        assert.equal(index.selectedSourceDepth, 3);
        assert.match(index.sourceContentSha256, /^[a-f0-9]{64}$/);
        const root = json(resolve(directory, index.path)).root;
        assert.equal(root.geometricError, 0);
        assert.equal(root.children?.length || 0, 0);
        assert.equal(root.content.uri, index.sourceContentPath.split('/').at(-1).replace(/\.json$/, '.b3dm'));
      }
    }
    assert.equal(source.lodStrategy.meshesAndTexturesUnmodified, true);
    assert.ok(Number.isInteger(source.lodStrategy.maxTreeDepth) && source.lodStrategy.maxTreeDepth >= (source.selectedSourceRoots ? 0 : 1) && source.lodStrategy.maxTreeDepth <= 5);
    assert.ok(!/key=|token=/i.test(JSON.stringify(source)));
    function size(path) {
      return readdirSync(path, { withFileTypes: true }).reduce((sum, entry) => {
        const target = resolve(path, entry.name);
        return sum + (entry.isDirectory() ? size(target) : statSync(target).size);
      }, 0);
    }
    assert.equal(size(directory), source.totalBytes);
    assert.ok(source.totalBytes <= 150 * 1024 * 1024);
    if (source.collection) {
      for (const [index, part] of parts.entries()) {
        assert.equal(size(part.directory), part.source.totalBytes);
        assert.equal(part.source.sourceRevisionDate, new Intl.DateTimeFormat('en-CA', { timeZone: part.source.revisionDateTimezone, year: 'numeric', month: '2-digit', day: '2-digit' }).format(part.source.sourceRevisionTimestamp));
        assert.equal(part.source.licenseUrl, source.licenseUrl);
        for (const key of ['sheet', 'bounds', 'recordQueryUrl', 'sourceRevisionDate', 'sourceRevisionTimestamp', 'tileCount', 'tileBytes']) {
          assert.deepEqual(source.sourceParts[index][key], part.source[key]);
        }
      }
      assert.equal(source.sourceRevisionTimestamp, Math.max(...parts.map(part => part.source.sourceRevisionTimestamp)));
    }
  });
}
