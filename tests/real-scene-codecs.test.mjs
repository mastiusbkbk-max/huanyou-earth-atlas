import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';
import vm from 'node:vm';
import { parse } from '@loaders.gl/core';
import { Tiles3DLoader } from '@loaders.gl/3d-tiles';
import { _getMemoryUsageGLTF } from '@loaders.gl/gltf';
import { createGLTFTexture } from '@luma.gl/gltf';

const root = fileURLToPath(new URL('../', import.meta.url));
const require = createRequire(import.meta.url);
const production = readFileSync(resolve(root, 'src/real-scene-codecs.js'), 'utf8')
  .replace(/^import .*;\n/gm, '')
  .replace('export const SceneTilesLoader', 'const SceneTilesLoader')
  .replace('export function loadSceneCodecs', 'function loadSceneCodecs');

function factory(name) {
  const path = resolve(root, 'public/codecs', name);
  const module = { exports: {} };
  return new Function('exports', 'module', 'require', '__dirname', '__filename',
    readFileSync(path, 'utf8') + '\nreturn module.exports;')(
    module.exports, module, require, dirname(path), path);
}

test('production local codecs decode Peak Float64 UVs and all nine KTX2 photographs without network', async t => {
  const requests = [];
  const unexpected = [];
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async input => {
    unexpected.push(String(input));
    throw new Error(`Network is forbidden in the real-scene codec test: ${input}`);
  };
  t.after(() => { globalThis.fetch = originalFetch; });
  const prefix = '/china-atlas/codecs/';
  const scripts = { 'draco_wasm_wrapper.js': 'DracoDecoderModule', 'basis_encoder.js': 'BASIS' };
  let removed = 0;
  // Node has no browser ImageData; stand in only for that built-in container.
  class ImageData {
    constructor(data, width, height) { this.data = data; this.width = width; this.height = height; }
  }
  const context = vm.createContext({
    Tiles3DLoader, _getMemoryUsageGLTF, ImageData, Uint8ClampedArray,
    document: {
      createElement(tag) {
        assert.equal(tag, 'script');
        return { remove() { removed++; } };
      },
      head: { append(element) {
        assert.ok(element.src.startsWith(prefix));
        const name = element.src.slice(prefix.length);
        assert.ok(scripts[name]);
        requests.push(name);
        context[scripts[name]] = factory(name);
        element.onload();
      } },
    },
    fetch: async input => {
      assert.ok(input.startsWith(prefix));
      const name = input.slice(prefix.length);
      assert.ok(['draco_decoder.wasm', 'basis_encoder.wasm'].includes(name));
      requests.push(name);
      const bytes = readFileSync(resolve(root, 'public/codecs', name));
      return { ok: true, arrayBuffer: async () => bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength) };
    },
  });
  new vm.Script(production, { filename: 'real-scene-codecs.js' }).runInContext(context);
  const SceneTilesLoader = vm.runInContext('SceneTilesLoader', context);
  const ready = context.loadSceneCodecs(prefix);
  assert.equal(context.loadSceneCodecs(prefix), ready, 'concurrent initialization shares the actual codecs');
  const options = await ready;
  assert.equal(context.loadSceneCodecs(prefix), ready, 'ready decoders are reused');
  assert.deepEqual(new Set(requests), new Set([...Object.keys(scripts), 'draco_decoder.wasm', 'basis_encoder.wasm']));
  assert.equal(requests.length, 4);
  assert.equal(removed, 2);

  const path = '11-SW-13C-9/Tile_223_098_L16_000.b3dm';
  const tile = await parse(readFileSync(resolve(root, 'public/models/hong-kong-peak', path)), SceneTilesLoader, {
    ...options, '3d-tiles': { isTileset: false, loadGLTF: true, assetGltfUpAxis: 'Z' },
  });
  for (const primitive of tile.gltf.meshes.flatMap(mesh => mesh.primitives)) {
    const positions = primitive.attributes.POSITION;
    const uv = primitive.attributes.TEXCOORD_0;
    assert.ok(positions.value.length > 0);
    assert.equal(uv.value.length / uv.size, positions.value.length / positions.size);
    assert.ok(positions.value.every(Number.isFinite));
    assert.ok(uv.value.every(Number.isFinite), 'source Float64 UVs decode through the production compatibility adapter');
    assert.ok(primitive.indices.value.length > 0);
  }
  assert.equal(tile.gltf.images.length, 9);
  for (const [index, image] of tile.gltf.images.entries()) {
    assert.equal(image.mimeType, 'image/ktx2');
    const level = image.image;
    assert.equal(level.width, index === 0 ? 1024 : index === 2 ? 32 : 16);
    assert.equal(level.height, index === 0 ? 1024 : 16);
    assert.ok(level instanceof ImageData);
    assert.ok(level.data instanceof Uint8ClampedArray);
    assert.deepEqual(Object.keys(level).sort(), ['data', 'height', 'width']);
    assert.equal('compressed' in level, false, 'luma.gl routes by key presence, even for compressed: false');
    assert.equal('mipmaps' in level, false);
    assert.equal(level.data.byteLength, level.width * level.height * 4);
    assert.ok(level.data.some(value => value !== 0), 'photography contains decoded pixels');
    const uploads = [];
    const texture = createGLTFTexture({
      getExternalImageSize(image) { assert.ok(image instanceof ImageData); return { width: image.width, height: image.height }; },
      createTexture(props) { uploads.push(props); return props; }
    }, level, {
      id: `peak-photo-${index}`,
      sampler: { minFilter: 'linear', magFilter: 'linear', mipmapFilter: 'none' },
    });
    assert.equal(uploads.length, 1, 'the actual luma.gl texture factory performs one upload');
    assert.equal(texture.data, level, 'the RGBA path uploads decoded pixels instead of a transparent fallback');
    assert.equal(texture.width, level.width);
    assert.equal(texture.height, level.height);
    assert.equal(texture.mipLevels, 1);
  }
  assert.ok(Number.isFinite(tile.gpuMemoryUsageInBytes) && tile.gpuMemoryUsageInBytes > 0);
  assert.equal(tile.gpuMemoryUsageInBytes, _getMemoryUsageGLTF(tile.gltf));
  const tileset = await parse(readFileSync(resolve(root, 'public/models/hong-kong-peak/tileset.json')), SceneTilesLoader, {
    ...options, '3d-tiles': { isTileset: true, assetGltfUpAxis: 'Z' },
  });
  assert.equal(tileset.loader, SceneTilesLoader, 'native child loads retain normalization before cache accounting');
  assert.deepEqual(unexpected, []);
});
