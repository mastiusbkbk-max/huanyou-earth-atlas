import { MapLibreOverlay } from '@deck.gl/maplibre';
import { Tile3DLayer } from '@deck.gl/geo-layers';
import { Matrix4 } from '@math.gl/core';
import { SceneTilesLoader } from './real-scene-codecs.js';

export function createRealSceneRenderer(map, { url, codecs, center, datumOffset = 0, onStatus = () => {} }) {
  const controller = new AbortController();
  let destroyed = false;
  let overlay = null;
  let layer;
  let status = '';

  const report = (next, detail) => {
    if (destroyed || status === next) return;
    status = next;
    onStatus(next, detail);
  };
  const reportError = error => {
    if (!controller.signal.aborted) report('error', error instanceof Error ? error : new Error(String(error)));
  };

  // deck.gl 9.4.0 starts this promise without catching root-tileset errors.
  class ManagedTile3DLayer extends Tile3DLayer {
    static layerName = 'ManagedTile3DLayer';
    _updateTileset(viewports) {
      if (destroyed) return;
      const tileset = this.state?.tileset3d;
      if (tileset) {
        const error = map.isMoving() ? 8 : 4;
        if (tileset.options.maximumScreenSpaceError !== error) {
          tileset.options.maximumScreenSpaceError = error;
          // Reset immediately; the library otherwise restores detail by 2% per traversal.
          tileset.memoryAdjustedScreenSpaceError = error;
        }
      }
      return super._updateTileset(viewports);
    }
    async _loadTileset(value) {
      try {
        await super._loadTileset(value);
        if (destroyed && this.state?.tileset3d) {
          this.state.tileset3d.destroy();
          this.state.tileset3d = null;
        } else if (!destroyed && this.state?.lastUpdatedViewports && !Object.keys(this.state.activeViewports).length) {
          // The initial viewport may already have been consumed while JSON loaded.
          this._updateTileset(this.state.lastUpdatedViewports);
        }
      } catch (error) {
        reportError(error);
      }
    }
  }

  const updateSceneView = () => {
    if (destroyed) return;
    layer?._updateTileset(layer.state?.lastUpdatedViewports);
    map.triggerRepaint();
  };
  const destroy = () => {
    if (destroyed) return;
    destroyed = true;
    map.off('movestart', updateSceneView);
    map.off('moveend', updateSceneView);
    controller.abort();
    overlay?.finalize();
    overlay = null;
  };

  report('loading');
  try {
    const translation = datumOffset ? (() => {
      const longitude = center[0] * Math.PI / 180;
      const latitude = center[1] * Math.PI / 180;
      return [
        datumOffset * Math.cos(latitude) * Math.cos(longitude),
        datumOffset * Math.cos(latitude) * Math.sin(longitude),
        datumOffset * Math.sin(latitude)
      ];
    })() : null;
    const correctedTilesets = new WeakSet();
    const correctRegionBounds = tileset => {
      if (destroyed || correctedTilesets.has(tileset)) return;
      correctedTilesets.add(tileset);
      const correctedTiles = new WeakSet();
      const correctTree = tile => {
        if (!tile || correctedTiles.has(tile)) return;
        correctedTiles.add(tile);
        for (const [header, volume] of [
          [tile.header.boundingVolume, tile.boundingVolume],
          [tile.header.content?.boundingVolume, tile._contentBoundingVolume],
          [tile.header.viewerRequestVolume, tile._viewerRequestVolume]
        ]) {
          if (header?.region && volume) volume.center.add(translation);
        }
        for (const child of tile.children) correctTree(child);
      };
      // loaders.gl 4.4.3 applies modelMatrix to boxes/spheres but ignores it for regions.
      // Correct current bounds and every later viewport/external tree before culling.
      const initializeHeaders = tileset._initializeTileHeaders;
      tileset._initializeTileHeaders = function (...args) {
        const root = initializeHeaders.apply(this, args);
        correctTree(root);
        return root;
      };
      correctTree(tileset.root);
      for (const root of Object.values(tileset.roots)) correctTree(root);
    };
    layer = new ManagedTile3DLayer({
      id: 'real-city-scene',
      data: url,
      loaders: codecs ? [SceneTilesLoader] : undefined,
      pickable: false,
      // Aerial textures already contain sunlight and shadows.
      _subLayerProps: { scenegraph: { _lighting: 'flat' } },
      loadOptions: {
        ...codecs,
        core: { fetch: (input, options) => fetch(input, { ...options, signal: controller.signal }) },
        tileset: {
          ...(translation ? { modelMatrix: new Matrix4().translate(translation) } : {}),
          maximumScreenSpaceError: 4,
          // Retained tile budget in MiB; individual selected tiles can exceed it.
          maximumMemoryUsage: 1536,
          memoryAdjustedScreenSpaceError: true,
          throttleRequests: true,
          maxRequests: 32,
          debounceTime: 0
        }
      },
      ...(translation ? { onTilesetLoad: correctRegionBounds } : {}),
      onTileLoad: tile => {
        const content = tile.content;
        if ((tile.type === 'scenegraph' && content?.gltf) || (tile.type === 'mesh' && content?.attributes)) report('ready');
      },
      // loaders.gl invokes this as (tile, message, url).
      onTileError: (_tile, message, resource) => reportError(new Error(`${message}${resource ? ` (${resource})` : ''}`)),
      onError: error => { reportError(error); return true; }
    });
    overlay = new MapLibreOverlay({
      interleaved: true,
      layers: [layer],
      onError: error => { reportError(error); return true; }
    });
    // Use lighter geometry during interaction, then request native detail on release.
    map.on('movestart', updateSceneView);
    map.on('moveend', updateSceneView);
    map.addControl(overlay);
  } catch (error) {
    reportError(error);
    destroy();
  }

  return { destroy };
}
