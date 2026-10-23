import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, readFile, writeFile, rm, stat, truncate, symlink } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { prepareApp, prepareModels } from '../scripts/prepare-pages.mjs';

async function fixture(t) {
  const root = await mkdtemp(join(tmpdir(), 'atlas-pages-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  await writeFile(join(root, 'package.json'), '{"type":"module"}');
  return root;
}

async function put(root, name, bytes = 'original bytes') {
  await mkdir(join(root, name, '..'), { recursive: true });
  await writeFile(join(root, name), bytes);
}

async function app(root, name = 'dist-pages') {
  const output = join(root, name);
  await put(output, 'index.html', '<html>寰游</html>');
  await put(output, 'assets/main-12345678.js', 'export const globe = true;');
  return output;
}

test('app trims only deployment duplicates and preserves all PC photos, map data and lossless DEM', async t => {
  const root = await fixture(t);
  const output = await app(root);
  const retained = {
    'tiles/terrain-webp/3/6/3.webp': Buffer.from([82, 73, 70, 70, 0, 255]),
    'tiles/relief/3/6/3.jpg': Buffer.from([255, 216, 1]),
    'tiles/satellite/3/6/3.jpg': Buffer.from([255, 216, 2]),
    'images/details/8k.jpg': Buffer.from([255, 216, 0, 255, 128]),
    'data/tiles-world.json': '{"terrain":["3/6/3"]}',
    'codecs/draco.wasm': Buffer.from([0, 97, 115, 109]),
    'fonts/chinese.woff2': Buffer.from([119, 79, 70, 50]),
  };
  for (const [name, bytes] of Object.entries(retained)) await put(output, name, bytes);
  for (const name of ['models/old/mesh.b3dm', 'tiles/terrain/3/6/3.png', 'assets/main-12345678.js.br', 'assets/main-12345678.js.gz', 'data/a.json.gz', 'static-delivery.json']) await put(output, name);
  await put(root, 'public/models/old/mesh.b3dm', 'source model');
  await put(root, 'dist/models/old/mesh.b3dm', 'local production');
  const result = await prepareApp(output, root);
  assert.equal(result.mode, 'app');
  assert.ok(result.bytes > 0 && result.bytes < 1_000_000_000);
  for (const [name, bytes] of Object.entries(retained)) assert.deepEqual(await readFile(join(output, name)), Buffer.from(bytes));
  for (const name of ['models', 'tiles/terrain', 'assets/main-12345678.js.br', 'assets/main-12345678.js.gz', 'data/a.json.gz', 'static-delivery.json']) await assert.rejects(stat(join(output, name)), { code: 'ENOENT' });
  assert.equal((await readFile(join(output, '.nojekyll'))).length, 0);
  assert.equal(await readFile(join(root, 'public/models/old/mesh.b3dm'), 'utf8'), 'source model');
  assert.equal(await readFile(join(root, 'dist/models/old/mesh.b3dm'), 'utf8'), 'local production');
});

test('app refuses source/local-production paths and their symlink aliases', async t => {
  const root = await fixture(t);
  for (const name of ['dist', 'public', 'src']) {
    const path = await app(root, name);
    await assert.rejects(prepareApp(path, root), /Refusing to modify source/);
    assert.ok((await stat(join(path, 'index.html'))).isFile());
  }
  await symlink(join(root, 'public'), join(root, 'alias'));
  await assert.rejects(prepareApp(join(root, 'alias'), root), /Refusing to modify source/);
  await assert.rejects(prepareModels(join(root, 'alias', 'new-output'), root), /Refusing to modify source/);
  await assert.rejects(stat(join(root, 'public', 'new-output')), { code: 'ENOENT' });
  await assert.rejects(prepareApp(root, root), /Refusing to modify source/);
});

test('app enforces strict per-file and total Pages limits using sparse files', async t => {
  const root = await fixture(t);
  const oversized = await app(root, 'oversized');
  await put(oversized, 'images/huge.bin', '');
  await truncate(join(oversized, 'images/huge.bin'), 100 * 1024 * 1024);
  await assert.rejects(prepareApp(oversized, root), /smaller than 100 MiB/);
  const overtotal = await app(root, 'overtotal');
  for (let i = 0; i < 10; i++) {
    await put(overtotal, `images/${i}.bin`, '');
    await truncate(join(overtotal, `images/${i}.bin`), 100_000_000);
  }
  await assert.rejects(prepareApp(overtotal, root), /smaller than 1,000,000,000 bytes/);
});

async function modelFixture(t) {
  const root = await fixture(t);
  await put(root, 'src/world-scenes.js', `export const worldScenes = [{ url: 'models/legacy/tileset.json', pcUrl: 'models/pc/tileset.json', tabletUrl: 'models/tablet/tileset.json', terrainSource: { tiles: ['models/ground/14/{x}/{y}.png'] } }];`);
  await put(root, 'src/real-scene.js', `export const realScenes = [{ url: 'models/hong-kong/tileset.json' }];`);
  const files = {
    'pc/tileset.json': JSON.stringify({ root: { content: { uri: 'nested/tileset.json' } } }),
    'pc/nested/tileset.json': JSON.stringify({ root: { content: { url: 'native-8k.b3dm' } } }),
    'pc/nested/native-8k.b3dm': Buffer.from([98, 51, 100, 109, 0, 255, 128, 0]),
    'pc/source.json': JSON.stringify({ license: 'preserved', originalTextureWidth: 8192 }),
    'hong-kong/tileset.json': JSON.stringify({ root: { content: { uri: 'all-lods.b3dm' } } }),
    'hong-kong/all-lods.b3dm': Buffer.from([1, 2, 3, 255]),
    'ground/14/1/2.png': Buffer.from([137, 80, 78, 71, 0, 255]),
    'ground/source.json': JSON.stringify({ officialTIN: true, fallbackPixels: 4 }),
  };
  for (const [name, bytes] of Object.entries(files)) await put(root, `public/models/${name}`, bytes);
  await put(root, 'public/models/legacy/tileset.json');
  await put(root, 'public/models/tablet/tileset.json');
  return { root, files };
}

test('models select PC or native fallback plus terrain, preserving every byte, dependency, LOD and source record', async t => {
  const { root, files } = await modelFixture(t);
  const output = join(root, 'models-pages');
  const result = await prepareModels(output, root);
  assert.equal(result.directories, 3);
  assert.equal(result.modelFiles, Object.keys(files).length);
  const manifest = JSON.parse(await readFile(join(output, 'asset-manifest.json'), 'utf8'));
  assert.deepEqual(manifest.directories, ['ground', 'hong-kong', 'pc']);
  for (const [name, value] of Object.entries(files)) {
    const bytes = Buffer.from(value);
    assert.deepEqual(await readFile(join(output, 'models', name)), bytes);
    const entry = manifest.files.find(file => file.path === `models/${name}`);
    assert.equal(entry.bytes, bytes.length);
    assert.equal(entry.sha256, createHash('sha256').update(bytes).digest('hex'));
  }
  assert.equal(manifest.modelBytes, Object.values(files).reduce((sum, value) => sum + Buffer.byteLength(value), 0));
  await assert.rejects(stat(join(output, 'models/legacy')), { code: 'ENOENT' });
  await assert.rejects(stat(join(output, 'models/tablet')), { code: 'ENOENT' });
  assert.match(await readFile(join(output, 'index.html'), 'utf8'), /asset-manifest.json/);
  assert.ok((await stat(join(output, '.nojekyll'))).isFile());
});

test('models refuse nonempty output and reject missing or escaping tileset dependencies', async t => {
  const { root } = await modelFixture(t);
  const output = join(root, 'occupied');
  await put(output, 'keep.txt', 'untouched');
  await assert.rejects(prepareModels(output, root), /nonempty output/);
  assert.equal(await readFile(join(output, 'keep.txt'), 'utf8'), 'untouched');
  await put(root, 'public/models/pc/nested/tileset.json', '{"root":{"content":{"uri":"missing.b3dm"}}}');
  await assert.rejects(prepareModels(join(root, 'missing'), root), /Missing or outside model dependency/);
  await put(root, 'public/models/pc/nested/tileset.json', '{"root":{"content":{"uri":"../../../index.html"}}}');
  await assert.rejects(prepareModels(join(root, 'escape'), root), /Missing or outside model dependency/);
});
