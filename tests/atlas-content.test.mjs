import test from 'node:test';
import assert from 'node:assert/strict';
import { places as chinaPlaces } from '../src/content.js';
import { worldPlaces } from '../src/content-world.js';
import { places, placeStories, chapters, highlights, countryNames, continents, matchesScope, coordinateLabel } from '../src/atlas-content.js';

test('the global atlas preserves every China destination and adds country scope without mutating it', () => {
  assert.equal(places.length, chinaPlaces.length + worldPlaces.length);
  assert.equal(new Set(places.map(place => place.id)).size, places.length);
  for (const original of chinaPlaces) {
    const combined = places.find(place => place.id === original.id);
    assert.deepEqual(combined, { ...original, country: '中国', continent: '亚洲' });
    assert.equal(original.country, undefined);
  }
  assert.equal(new Set(countryNames).size, countryNames.length);
  assert.ok(countryNames.includes('中国'));
  for (const place of places) {
    assert.ok(countryNames.includes(place.country), place.id);
    assert.ok(continents.includes(place.continent), place.id);
    assert.ok(placeStories[place.id], place.id);
  }
  for (const id of highlights) assert.ok(places.some(place => place.id === id), id);
  for (const chapter of chapters) for (const id of chapter.placeIds) assert.ok(places.some(place => place.id === id), `${chapter.title}: ${id}`);
});

test('continent and country filters are combined and retain both natural and cultural destinations', () => {
  const china = places.filter(place => matchesScope(place, '亚洲', '中国'));
  assert.deepEqual(china.map(place => place.id), chinaPlaces.map(place => place.id));
  const france = places.filter(place => matchesScope(place, '欧洲', '法国'));
  assert.ok(france.some(place => place.id === 'world-eiffel'));
  assert.ok(france.every(place => place.country === '法国' && place.continent === '欧洲'));
  assert.equal(places.filter(place => matchesScope(place, '亚洲', '法国')).length, 0);
  assert.equal(places.filter(place => matchesScope(place)).length, places.length);
  assert.ok(places.filter(place => matchesScope(place, '大洋洲')).some(place => place.category === 'nature'));
  assert.ok(places.filter(place => matchesScope(place, '大洋洲')).some(place => place.category === 'culture'));
});

test('coordinates name the correct southern and western hemispheres', () => {
  assert.equal(coordinateLabel([151.2153, -33.8568]), '33.86° S / 151.22° E');
  assert.equal(coordinateLabel([-74.0445, 40.6892]), '40.69° N / 74.04° W');
  assert.equal(coordinateLabel([-72.545, -13.163]), '13.16° S / 72.55° W');
  assert.equal(coordinateLabel([0, 0]), '0.00° N / 0.00° E');
});
