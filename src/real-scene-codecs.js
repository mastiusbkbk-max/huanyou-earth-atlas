import { Tiles3DLoader } from '@loaders.gl/3d-tiles';
import { _getMemoryUsageGLTF } from '@loaders.gl/gltf';

// Normalize decoded photography before Tileset3D records GPU cache usage.
export const SceneTilesLoader = {
  ...Tiles3DLoader,
  async parse(...args) {
    const tile = await Tiles3DLoader.parse(...args);
    if (tile.loader) tile.loader = SceneTilesLoader;
    if (tile.gltf) {
      for (const image of tile.gltf.images || []) {
        if (image.mimeType === 'image/ktx2' && image.image?.data?.[0]?.data) {
          const level = image.image.data[0];
          // luma.gl routes any object with a "compressed" key to its compressed
          // upload path, even when the value is false. These pixels are RGBA.
          image.image = new ImageData(new Uint8ClampedArray(level.data), level.width, level.height);
        }
      }
      tile.gpuMemoryUsageInBytes = _getMemoryUsageGLTF(tile.gltf);
    }
    return tile;
  }
};

let ready;

function script(url, name) {
  if (globalThis[name]) return Promise.resolve(globalThis[name]);
  return new Promise((resolve, reject) => {
    const element = document.createElement('script');
    element.src = url;
    element.onload = () => { element.remove(); resolve(globalThis[name]); };
    element.onerror = () => { element.remove(); reject(new Error(`Cannot load ${name}`)); };
    document.head.append(element);
  });
}

// Only the Peak's compressed photography needs these local WASM decoders.
export function loadSceneCodecs(baseUrl) {
  ready ??= (async () => {
    const binary = async name => {
      const response = await fetch(`${baseUrl}${name}`);
      if (!response.ok) throw new Error(`Cannot load ${name}: ${response.status}`);
      return response.arrayBuffer();
    };
    const [dracoFactory, dracoWasm, basisFactory, basisWasm] = await Promise.all([
      script(`${baseUrl}draco_wasm_wrapper.js`, 'DracoDecoderModule'), binary('draco_decoder.wasm'),
      script(`${baseUrl}basis_encoder.js`, 'BASIS'), binary('basis_encoder.wasm')
    ]);
    const [draco, basis] = await Promise.all([
      dracoFactory({ wasmBinary: dracoWasm }), basisFactory({ wasmBinary: basisWasm })
    ]);
    // loaders.gl 4.4 omits Float64 attributes. Draco converts the source UVs
    // to GPU Float32 on decode; the original model bytes remain untouched.
    const dataType = draco.PointAttribute.prototype.data_type;
    draco.PointAttribute.prototype.data_type = function () {
      const type = dataType.call(this);
      return type === draco.DT_FLOAT64 ? draco.DT_FLOAT32 : type;
    };
    basis.initializeBasis();
    return {
      worker: false,
      modules: { draco3d: { createDecoderModule: async () => draco }, basisEncoder: Object.assign(() => {}, basis) },
      basis: { module: 'encoder', format: 'rgba32' },
      gltf: { loadImages: true, decompressMeshes: true }
    };
  })().catch(error => { ready = null; throw error; });
  return ready;
}
