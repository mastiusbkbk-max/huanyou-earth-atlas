import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import test from 'node:test';
import { worldPlaces } from '../src/content-world.js';
import { worldScenes } from '../src/world-scenes.js';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const manifest = JSON.parse(await readFile(join(root, 'public/data/tiles-world.json'), 'utf8'));
const frameMarkers = new Set([0xc0, 0xc1, 0xc2, 0xc3, 0xc5, 0xc6, 0xc7, 0xc9, 0xca, 0xcb, 0xcd, 0xce, 0xcf]);

function jpegDimensions(bytes) {
  assert.equal(bytes.readUInt16BE(0), 0xffd8);
  let offset = 2;
  while (offset + 8 < bytes.length) {
    assert.equal(bytes[offset++], 0xff);
    while (bytes[offset] === 0xff) offset++;
    const marker = bytes[offset++];
    if (marker === 0xda || marker === 0xd9) break;
    if (marker === 0x01 || marker >= 0xd0 && marker <= 0xd7) continue;
    const size = bytes.readUInt16BE(offset);
    assert.ok(size >= 2 && offset + size <= bytes.length);
    if (frameMarkers.has(marker)) return [bytes.readUInt16BE(offset + 5), bytes.readUInt16BE(offset + 3)];
    offset += size;
  }
  assert.fail('JPEG frame header not found');
}

function losslessWebPDimensions(bytes) {
  assert.equal(bytes.toString('ascii', 0, 4), 'RIFF');
  assert.equal(bytes.toString('ascii', 8, 12), 'WEBP');
  assert.equal(bytes.readUInt32LE(4) + 8, bytes.length);
  let dimensions;
  for (let offset = 12; offset + 8 <= bytes.length;) {
    const chunk = bytes.toString('ascii', offset, offset + 4);
    const size = bytes.readUInt32LE(offset + 4);
    assert.ok(offset + 8 + size <= bytes.length);
    assert.notEqual(chunk, 'VP8 ', 'Terrain must use lossless WebP');
    if (chunk === 'VP8L') {
      assert.equal(bytes[offset + 8], 0x2f);
      const header = bytes.readUInt32LE(offset + 9);
      dimensions = [(header & 0x3fff) + 1, ((header >>> 14) & 0x3fff) + 1];
    }
    offset += 8 + size + size % 2;
  }
  assert.ok(dimensions, 'Lossless WebP frame header not found');
  return dimensions;
}

test('world manifest counts and byte sizes match real JPEG and lossless WebP tiles', async () => {
  assert.equal(manifest.requested, manifest.tiles.total + manifest.failures.length + manifest.pending);
  assert.equal(manifest.failures.length, 0);
  assert.equal(manifest.pending, 0);
  const bytes = { satellite: 0, terrain: 0, total: 0 };
  for (const type of ['satellite', 'terrain']) {
    assert.equal(manifest[type].length, manifest.tiles[type]);
    assert.equal(new Set(manifest[type]).size, manifest[type].length);
    for (const key of manifest[type]) {
      assert.match(key, /^\d+\/\d+\/\d+$/);
      const path = `public/tiles/${type === 'terrain' ? 'terrain-webp' : 'satellite'}/${key}.${type === 'terrain' ? 'webp' : 'jpg'}`;
      const data = await readFile(join(root, path));
      assert.deepEqual(type === 'satellite' ? jpegDimensions(data) : losslessWebPDimensions(data), [256, 256], path);
      bytes[type] += data.length;
      bytes.total += data.length;
    }
  }
  assert.deepEqual(bytes, manifest.bytes);
  assert.equal(manifest.tiles.total, manifest.satellite.length + manifest.terrain.length);
});

test('every world destination has its promised satellite and enabled terrain coverage', () => {
  assert.equal(manifest.coverage.places, worldPlaces.length);
  assert.deepEqual(new Set(manifest.coverage.destinations.map(place => place.id)), new Set(worldPlaces.map(place => place.id)));
  const satellite = new Set(manifest.satellite);
  const terrain = new Set(manifest.terrain);
  for (const place of worldPlaces) {
    const coverage = manifest.coverage.destinations.find(item => item.id === place.id);
    assert.deepEqual(coverage.coordinate, place.coordinate, place.id);
    assert.equal(coverage.satellite.length, 18, place.id);
    assert.equal(coverage.successfulSatellite, 18, place.id);
    assert.ok(coverage.satellite.every(key => satellite.has(key)), place.id);
    assert.equal(coverage.terrain.length, place.terrain === false ? 0 : 18, place.id);
    assert.equal(coverage.successfulTerrain, coverage.terrain.length, place.id);
    assert.ok(coverage.terrain.every(key => terrain.has(key)), place.id);
    assert.deepEqual([...new Set(coverage.satellite.map(key => Number(key.split('/')[0])))]
      .sort((a, b) => a - b), [Math.floor(place.zoom), Math.round(place.zoom + 1)].sort((a, b) => a - b));
    if (place.terrain !== false) {
      const zoom = Math.min(14, Math.floor(place.zoom));
      assert.deepEqual([...new Set(coverage.terrain.map(key => Number(key.split('/')[0])))]
        .sort((a, b) => a - b), [zoom - 1, zoom]);
    }
  }
});

test('published world scenes have local satellite coverage at their actual camera centers', () => {
  assert.equal(manifest.coverage.scenes.length, worldScenes.length);
  const satellite = new Set(manifest.satellite);
  const terrain = new Set(manifest.terrain);
  for (const scene of worldScenes) {
    const coverage = manifest.coverage.scenes.find(item => item.id === scene.id);
    assert.ok(coverage, scene.id);
    assert.deepEqual(coverage.coordinate, scene.center, scene.id);
    assert.equal(coverage.successfulSatellite, coverage.satellite.length, scene.id);
    assert.ok(coverage.satellite.every(key => satellite.has(key)), scene.id);
    const levels = new Set(coverage.satellite.map(key => Number(key.split('/')[0])));
    assert.ok(levels.has(Math.floor(scene.zoom)), scene.id);
    assert.ok(levels.has(Math.round(scene.zoom + 1)), scene.id);
    if (scene.terrain) {
      assert.equal(coverage.terrain.length, 18, scene.id);
      assert.equal(coverage.successfulTerrain, 18, scene.id);
      assert.ok(coverage.terrain.every(key => terrain.has(key)), scene.id);
    }
  }
});
