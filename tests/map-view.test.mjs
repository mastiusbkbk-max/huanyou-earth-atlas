import test from 'node:test';
import assert from 'node:assert/strict';
import { places } from '../src/content.js';
import { terrainView } from '../src/map-view.js';

const bund = places.find(p => p.id === 'shanghai-bund');

test('the Bund uses a flat city surface and a restrained camera instead of urban DEM peaks', () => {
  assert.equal(bund.terrain, false);
  const view = terrainView(bund, true);
  assert.equal(view.enabled, false);
  assert.equal(view.available, false);
  assert.ok(view.pitch <= 30);
  assert.match(view.label, /城市影像/);
});

test('leaving the Bund preserves the requested terrain for mountains, cultural mountain sites and the overview', () => {
  const requested = true;
  assert.equal(terrainView(bund, requested).enabled, false);
  for (const id of ['everest', 'great-wall', 'kailash', 'huangshan']) {
    const place = places.find(p => p.id === id);
    const view = terrainView(place, requested);
    assert.equal(view.enabled, true, id);
    assert.equal(view.pitch, place.pitch, id);
  }
  assert.equal(terrainView(null, requested).enabled, true);
});

test('a user request to disable terrain remains off when moving between all destinations and the overview', () => {
  for (const place of [...places, null]) {
    const view = terrainView(place, false);
    assert.equal(view.enabled, false, place?.id);
    assert.equal(view.pitch, 0, place?.id);
  }
});
