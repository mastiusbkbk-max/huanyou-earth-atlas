import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import vm from 'node:vm';
import { Matrix4 } from '@math.gl/core';
import { Tileset3D } from '@loaders.gl/tiles';
import { Tiles3DLoader } from '@loaders.gl/3d-tiles';

// Run the production controller with only the two WebGL libraries replaced.
const source = (await readFile(new URL('../src/real-scene-renderer.js', import.meta.url), 'utf8'))
  .replace(/^import .*;\n/gm, '')
  .replace('export function createRealSceneRenderer', 'function createRealSceneRenderer');

function harness(options = {}) {
  let resolveRoot, rejectRoot, rootTask, layer, overlay;
  const root = new Promise((resolve, reject) => { resolveRoot = resolve; rejectRoot = reject; });
  const resources = [];
  const requests = [];
  const statuses = [];
  const selections = [];
  let moving = false;
  const map = {
    listeners: new Map(), repaints: 0,
    on(event, listener) {
      if (!this.listeners.has(event)) this.listeners.set(event, new Set());
      this.listeners.get(event).add(listener);
    },
    off(event, listener) { this.listeners.get(event)?.delete(listener); },
    isMoving() { return moving; },
    triggerRepaint() { this.repaints++; },
    emit(event) { for (const listener of this.listeners.get(event) || []) listener(); },
    addControl(control) { rootTask = control.props.layers[0]._loadTileset('tileset.json'); }
  };

  class Tile3DLayer {
    constructor(props) { this.props = props; this.state = { activeViewports: {} }; layer = this; }
    _updateTileset(viewports) {
      this.selectedViewports = viewports;
      this.state.lastUpdatedViewports = viewports;
      selections.push({ viewports, error: this.state.tileset3d?.options.maximumScreenSpaceError });
    }
    async _loadTileset() {
      await root;
      const resource = {
        options: { ...this.props.loadOptions.tileset },
        memoryAdjustedScreenSpaceError: this.props.loadOptions.tileset.maximumScreenSpaceError,
        releases: 0, destroy() { this.releases++; }
      };
      resources.push(resource);
      this.state.tileset3d = resource;
    }
  }
  class MapLibreOverlay {
    constructor(props) { this.props = props; this.finalizations = 0; overlay = this; }
    finalize() {
      this.finalizations++;
      layer.state.tileset3d?.destroy();
      layer.state.tileset3d = null;
    }
  }
  const context = vm.createContext({
    Tile3DLayer, MapLibreOverlay, Matrix4, AbortController,
    fetch: async (input, options) => { requests.push({ input, options }); return {}; }
  });
  new vm.Script(`'use strict';\n${source}`, { filename: 'real-scene-renderer.js' }).runInContext(context);
  const renderer = context.createRealSceneRenderer(map,
    { url: 'tileset.json', ...options, onStatus: (status, detail) => statuses.push({ status, detail }) });

  return {
    renderer, resources, requests, statuses, map, selections,
    setMoving(value) { moving = value; },
    get layer() { return layer; },
    get overlay() { return overlay; },
    async resolve() { resolveRoot(); await rootTask; },
    async reject(error) { rejectRoot(error); await rootTask; }
  };
}

test('real-scene readiness requires decoded mesh content, rather than metadata or point clouds', async () => {
  const h = harness();
  await h.resolve();
  h.layer.props.onTileLoad({ type: 'empty', content: {} });
  h.layer.props.onTileLoad({ type: 'pointcloud', content: { attributes: { positions: [] } } });
  assert.deepEqual(h.statuses.map(s => s.status), ['loading']);
  h.layer.props.onTileLoad({ type: 'scenegraph', content: { gltf: { meshes: [{}] } } });
  assert.deepEqual(h.statuses.map(s => s.status), ['loading', 'ready']);
  h.renderer.destroy();
});

test('a root arriving after the initial viewport was consumed still selects visible tiles', async () => {
  const h = harness();
  const viewports = { maplibre: { id: 'maplibre' } };
  h.layer.state.lastUpdatedViewports = viewports;
  await h.resolve();
  assert.equal(h.layer.selectedViewports, viewports);
  h.renderer.destroy();
});

test('an active viewport selected by the loader is not replaced with an older viewport', async () => {
  const h = harness();
  h.layer.state.lastUpdatedViewports = { old: { id: 'old' } };
  h.layer.state.activeViewports = { current: { id: 'current' } };
  await h.resolve();
  assert.equal(h.layer.selectedViewports, undefined);
  h.renderer.destroy();
});

test('movement events immediately select SSE 8, then restore SSE 4 without a new viewport event', async () => {
  const h = harness();
  const viewports = { maplibre: { id: 'maplibre' } };
  h.layer.state.lastUpdatedViewports = viewports;
  await h.resolve();
  const tileset = h.resources[0];
  assert.equal(tileset.options.maximumScreenSpaceError, 4);
  const initialSelections = h.selections.length;

  h.setMoving(true);
  h.map.emit('movestart');
  assert.equal(tileset.options.maximumScreenSpaceError, 8);
  assert.equal(tileset.memoryAdjustedScreenSpaceError, 8);
  assert.equal(h.selections.length, initialSelections + 1);
  assert.equal(h.selections.at(-1).viewports, viewports);
  assert.equal(h.selections.at(-1).error, 8);
  assert.equal(h.map.repaints, 1);

  h.setMoving(false);
  h.map.emit('moveend');
  assert.equal(tileset.options.maximumScreenSpaceError, 4);
  assert.equal(tileset.memoryAdjustedScreenSpaceError, 4);
  assert.equal(h.selections.length, initialSelections + 2);
  assert.equal(h.selections.at(-1).viewports, viewports);
  assert.equal(h.selections.at(-1).error, 4);
  assert.equal(h.map.repaints, 2);
  h.renderer.destroy();
});

test('updates within the same motion mode preserve the library memory-adjusted error', async () => {
  const h = harness();
  const viewports = { maplibre: { id: 'maplibre' } };
  h.layer.state.lastUpdatedViewports = viewports;
  await h.resolve();
  const tileset = h.resources[0];
  h.setMoving(true);
  h.map.emit('movestart');
  tileset.memoryAdjustedScreenSpaceError = 11;
  h.layer._updateTileset(viewports);
  h.map.emit('movestart');
  assert.equal(tileset.options.maximumScreenSpaceError, 8);
  assert.equal(tileset.memoryAdjustedScreenSpaceError, 11);

  h.setMoving(false);
  h.map.emit('moveend');
  assert.equal(tileset.memoryAdjustedScreenSpaceError, 4);
  tileset.memoryAdjustedScreenSpaceError = 6;
  h.layer._updateTileset(viewports);
  h.map.emit('moveend');
  assert.equal(tileset.options.maximumScreenSpaceError, 4);
  assert.equal(tileset.memoryAdjustedScreenSpaceError, 6);
  h.renderer.destroy();
});

test('a root arriving during motion uses SSE 8 and can restore detail with the saved viewport', async () => {
  const h = harness();
  const viewports = { maplibre: { id: 'maplibre' } };
  h.layer.state.lastUpdatedViewports = viewports;
  h.setMoving(true);
  h.map.emit('movestart');
  assert.equal(h.resources.length, 0);
  await h.resolve();
  const tileset = h.resources[0];
  assert.equal(tileset.options.maximumScreenSpaceError, 8);
  assert.equal(tileset.memoryAdjustedScreenSpaceError, 8);
  assert.equal(h.selections.at(-1).viewports, viewports);
  assert.equal(h.selections.at(-1).error, 8);
  h.setMoving(false);
  h.map.emit('moveend');
  assert.equal(tileset.options.maximumScreenSpaceError, 4);
  assert.equal(h.selections.at(-1).error, 4);
  h.renderer.destroy();
});

test('destroy unbinds motion listeners and queued motion callbacks cannot reselect or repaint', async () => {
  const h = harness();
  h.layer.state.lastUpdatedViewports = { maplibre: { id: 'maplibre' } };
  await h.resolve();
  assert.equal(h.map.listeners.get('movestart').size, 1);
  assert.equal(h.map.listeners.get('moveend').size, 1);
  const queuedCallbacks = [...h.map.listeners.get('movestart'), ...h.map.listeners.get('moveend')];
  h.renderer.destroy();
  h.renderer.destroy();
  assert.equal(h.map.listeners.get('movestart').size, 0);
  assert.equal(h.map.listeners.get('moveend').size, 0);
  const selections = h.selections.length;
  const repaints = h.map.repaints;
  h.setMoving(true);
  h.map.emit('movestart');
  h.map.emit('moveend');
  for (const callback of queuedCallbacks) callback();
  h.layer._updateTileset({ late: { id: 'late' } });
  assert.equal(h.selections.length, selections);
  assert.equal(h.map.repaints, repaints);
  assert.equal(h.resources[0].options.maximumScreenSpaceError, 4);
  assert.equal(h.resources[0].releases, 1);
});

test('destroy aborts scene requests, releases resources once and ignores late callbacks', async () => {
  const h = harness();
  await h.resolve();
  await h.layer.props.loadOptions.core.fetch('tile.b3dm');
  const signal = h.requests[0].options.signal;
  assert.equal(signal.aborted, false);
  h.renderer.destroy();
  h.renderer.destroy();
  assert.equal(signal.aborted, true);
  assert.equal(h.overlay.finalizations, 1);
  assert.equal(h.resources[0].releases, 1);
  h.layer.props.onTileLoad({ type: 'scenegraph', content: { gltf: {} } });
  h.layer.props.onTileError({}, 'late failure', 'tile.b3dm');
  assert.deepEqual(h.statuses.map(s => s.status), ['loading']);
});

test('a root tileset arriving after destroy is released and cannot reactivate the scene', async () => {
  const h = harness();
  h.renderer.destroy();
  await h.resolve();
  assert.equal(h.resources[0].releases, 1);
  assert.deepEqual(h.statuses.map(s => s.status), ['loading']);
});

test('an asynchronous root loading failure is handled and reported to the caller', async () => {
  const h = harness();
  await h.reject(new Error('root tileset unavailable'));
  assert.deepEqual(h.statuses.map(s => s.status), ['loading', 'error']);
  assert.match(h.statuses[1].detail.message, /root tileset unavailable/);
  h.renderer.destroy();
});

function ecef([longitude, latitude], height) {
  const lon = longitude * Math.PI / 180;
  const lat = latitude * Math.PI / 180;
  const e2 = 6.6943799901413165e-3;
  const radius = 6378137 / Math.sqrt(1 - e2 * Math.sin(lat) ** 2);
  return [
    (radius + height) * Math.cos(lat) * Math.cos(lon),
    (radius + height) * Math.cos(lat) * Math.sin(lon),
    (radius * (1 - e2) + height) * Math.sin(lat)
  ];
}

function closeVector(actual, expected, message) {
  for (let i = 0; i < 3; i++) assert.ok(Math.abs(actual[i] - expected[i]) < 1e-7, `${message}: axis ${i}, ${actual[i]} != ${expected[i]}`);
}

test('an omitted or zero datum offset leaves the tileset default matrix and callbacks intact', async () => {
  for (const options of [{}, { datumOffset: 0 }]) {
    const h = harness(options);
    assert.equal(Object.hasOwn(h.layer.props.loadOptions.tileset, 'modelMatrix'), false);
    assert.equal(Object.hasOwn(h.layer.props, 'onTilesetLoad'), false);
    await h.resolve();
    h.renderer.destroy();
  }
});

test('datum offsets move ECEF geometry along local geodetic up at real scene centers and the poles', async () => {
  for (const [center, datumOffset] of [
    [[4.83505, 45.7677], -49.438497493949654],
    [[24.9522, 60.16995], -17.861190283495475],
    [[24.9415, 60.1707], -17.8792592381012],
    [[0, 0], -50],
    [[0, 90], 50]
  ]) {
    const h = harness({ center, datumOffset });
    const matrix = h.layer.props.loadOptions.tileset.modelMatrix;
    closeVector(matrix.transformAsPoint(ecef(center, 230)), ecef(center, 230 + datumOffset), `height at ${center}`);
    await h.resolve();
    h.renderer.destroy();
  }
});

function fixture() {
  const region = [0.0843, 0.7987, 0.0845, 0.7990, 150, 250];
  return {
    asset: { version: '1.0' }, geometricError: 100,
    root: {
      transform: Array.from(new Matrix4().translate([100, -200, 300]).rotateZ(0.2)),
      boundingVolume: { region: [...region] }, geometricError: 100, refine: 'REPLACE',
      content: { uri: 'root.b3dm', boundingVolume: { region: [...region] } },
      viewerRequestVolume: { region: [...region] },
      children: [
        { boundingVolume: { region: [...region] }, geometricError: 0 },
        { boundingVolume: { sphere: [...ecef([4.83505, 45.7677], 200), 20] }, geometricError: 0 },
        { boundingVolume: { box: [...ecef([4.83505, 45.7677], 200), 20, 0, 0, 0, 20, 0, 0, 0, 20] }, geometricError: 0 }
      ]
    }
  };
}

async function normalized(json) {
  return Tiles3DLoader.parse(new TextEncoder().encode(JSON.stringify(json)).buffer,
    { '3d-tiles': { isTileset: true } }, { url: 'https://fixture.invalid/tileset.json' });
}

async function realTileset(json, options = {}) {
  const tileset = new Tileset3D(await normalized(json), options);
  await tileset.tilesetInitializationPromise;
  return tileset;
}

function tileVolumes(root) {
  return [root.boundingVolume, root._contentBoundingVolume, root._viewerRequestVolume,
    ...root.children.map(child => child.boundingVolume)];
}

test('the same ECEF offset reaches geometry and all region, sphere and box culling bounds without editing headers', async () => {
  const json = fixture();
  const original = JSON.stringify(json);
  const h = harness({ center: [4.83505, 45.7677], datumOffset: -49.438497493949654 });
  const matrix = h.layer.props.loadOptions.tileset.modelMatrix;
  const translation = matrix.transformAsPoint([0, 0, 0]);
  const baseline = await realTileset(json);
  const shifted = await realTileset(json, h.layer.props.loadOptions.tileset);
  h.layer.props.onTilesetLoad(shifted);
  h.layer.props.onTilesetLoad(shifted);
  for (const [i, volume] of tileVolumes(shifted.root).entries()) {
    const before = tileVolumes(baseline.root)[i];
    closeVector(volume.center, before.center.map((v, axis) => v + translation[axis]), `volume ${i}`);
  }
  const point = [3, 5, 7];
  closeVector(shifted.root.computedTransform.transformAsPoint(point),
    baseline.root.computedTransform.transformAsPoint(point).map((v, axis) => v + translation[axis]), 'composed model transform');
  assert.equal(JSON.stringify(json), original);
  assert.deepEqual(shifted.root.header.transform, baseline.root.header.transform);
  // Normal frame traversal uses the same fixed matrix and preserves corrected bounds.
  shifted.root._updateTransform(shifted.modelMatrix);
  closeVector(shifted.root.boundingVolume.center,
    baseline.root.boundingVolume.center.map((v, axis) => v + translation[axis]), 'next frame root region');
  baseline.destroy(); shifted.destroy();
  await h.resolve(); h.renderer.destroy();
});

test('later viewport roots and nested external trees get corrected before traversal', async () => {
  const json = fixture();
  const h = harness({ center: [24.9522, 60.16995], datumOffset: -17.861190283495475 });
  const baseline = await realTileset(json);
  const shifted = await realTileset(json, h.layer.props.loadOptions.tileset);
  // Also cover an already-created viewport tree when Deck invokes the callback.
  shifted.roots.existing = shifted._initializeTileHeaders(await normalized(json), null);
  h.layer.props.onTilesetLoad(shifted);
  const translation = shifted.modelMatrix.transformAsPoint([0, 0, 0]);
  const future = shifted._initializeTileHeaders(await normalized(json), null);
  const external = shifted._initializeTileHeaders(await normalized(json), future.children[0]);
  for (const root of [shifted.root, shifted.roots.existing, future, external]) {
    closeVector(root.boundingVolume.center,
      baseline.root.boundingVolume.center.map((v, axis) => v + translation[axis]), 'later region');
  }
  assert.equal(future.children[0].children[0], external);
  baseline.destroy(); shifted.destroy();
  await h.resolve(); h.renderer.destroy();
});

test('a late tileset callback after destruction cannot install culling hooks', async () => {
  const h = harness({ center: [0, 0], datumOffset: -50 });
  h.renderer.destroy();
  const tileset = await realTileset(fixture(), h.layer.props.loadOptions.tileset);
  const initialize = tileset._initializeTileHeaders;
  const center = [...tileset.root.boundingVolume.center];
  h.layer.props.onTilesetLoad(tileset);
  assert.equal(tileset._initializeTileHeaders, initialize);
  assert.deepEqual([...tileset.root.boundingVolume.center], center);
  tileset.destroy();
  await h.resolve();
});
