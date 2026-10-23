import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { places as chinaPlaces, themes } from '../src/content.js';
import { worldPlaces, worldStories, worldChapters, worldSources, countryNames } from '../src/content-world.js';

const readJson = path => JSON.parse(readFileSync(new URL(path, import.meta.url), 'utf8'));
const covers = readJson('../public/data/photo-sources-world.json');
const details = readJson('../public/data/detail-photos-world.json');
const evidence = readJson('../scripts/world-photo-sources/license-evidence.json');
const ids = new Set(worldPlaces.map(p => p.id));
const manifest = readJson('../scripts/world-manifest.json');

function assertHttps(url, label) {
  const parsed = new URL(url);
  assert.equal(parsed.protocol, 'https:', `${label}: use a traceable HTTPS reference`);
  assert.ok(parsed.hostname.includes('.'), `${label}: invalid reference host`);
  return parsed;
}

function localFile(path) {
  assert.match(path, /^\/images\/(?:details\/)?world-[a-z-]+\.jpg$/);
  return readFileSync(new URL(`../public${path}`, import.meta.url));
}

function jpegSize(data) {
  assert.deepEqual([...data.subarray(0, 3)], [0xff, 0xd8, 0xff], 'Not a JPEG photograph');
  const frameMarkers = new Set([0xc0, 0xc1, 0xc2, 0xc3, 0xc5, 0xc6, 0xc7, 0xc9, 0xca, 0xcb, 0xcd, 0xce, 0xcf]);
  let offset = 2;
  while (offset + 4 < data.length) {
    assert.equal(data[offset], 0xff, 'Malformed JPEG marker');
    while (data[offset] === 0xff) offset++;
    const marker = data[offset++];
    if (marker === 0xda || marker === 0xd9) break;
    const length = data.readUInt16BE(offset);
    if (frameMarkers.has(marker)) return [data.readUInt16BE(offset + 5), data.readUInt16BE(offset + 3)];
    assert.ok(length >= 2, 'Malformed JPEG segment length');
    offset += length;
  }
  assert.fail('JPEG has no image dimensions');
}

function webpSize(data) {
  assert.equal(data.toString('ascii', 0, 4), 'RIFF', 'Thumbnail has no RIFF header');
  assert.equal(data.toString('ascii', 8, 12), 'WEBP', 'Thumbnail is not WebP');
  let offset = 12;
  while (offset + 8 < data.length) {
    const kind = data.toString('ascii', offset, offset + 4);
    const length = data.readUInt32LE(offset + 4);
    const start = offset + 8;
    if (kind === 'VP8X') return [data.readUIntLE(start + 4, 3) + 1, data.readUIntLE(start + 7, 3) + 1];
    if (kind === 'VP8 ') {
      assert.deepEqual([...data.subarray(start + 3, start + 6)], [0x9d, 0x01, 0x2a]);
      return [data.readUInt16LE(start + 6) & 0x3fff, data.readUInt16LE(start + 8) & 0x3fff];
    }
    if (kind === 'VP8L') {
      assert.equal(data[start], 0x2f);
      const bits = data.readUInt32LE(start + 1);
      return [(bits & 0x3fff) + 1, ((bits >>> 14) & 0x3fff) + 1];
    }
    offset = start + length + (length % 2);
  }
  assert.fail('WebP has no image dimensions');
}

function assertPhoto(photo, label) {
  for (const key of ['id', 'title', 'author', 'license', 'sourceUrl', 'licenseUrl', 'credit', 'modifications', 'licenseEvidenceUrl']) {
    assert.ok(typeof photo[key] === 'string' && photo[key].trim(), `${label}: missing ${key}`);
  }
  assert.equal(assertHttps(photo.sourceUrl, label).hostname, 'commons.wikimedia.org');
  assert.match(new URL(photo.sourceUrl).pathname, /^\/wiki\/File:/, `${label}: cite the actual Commons file`);
  assert.equal(assertHttps(photo.licenseUrl, label).hostname, 'creativecommons.org');
  assert.match(photo.license, /^CC(?:0| BY(?:-SA)? \d\.\d(?: [a-z]{2}| IGO)?)$/, `${label}: missing an explicit supported photographic license`);
  assert.doesNotMatch(photo.license, /Public domain|PD-old|unknown/i, `${label}: no inferred public-domain license`);
  assert.match(photo.modifications, /resiz/i, `${label}: disclose image processing`);
  assert.equal(photo.mediaType, 'photograph', `${label}: use a real photograph`);
  const proof = evidence[`File:${photo.title}`];
  assert.ok(proof, `${label}: missing original-page licensing evidence`);
  assert.equal(proof.literalLicenseEvidence, true, `${label}: no explicit photographic license template`);
  assert.deepEqual(proof.errors, [], `${label}: unresolved licensing issue`);
  assert.equal(proof.author, photo.author, `${label}: author disagrees with licensing evidence`);
  assert.equal(proof.license, photo.license, `${label}: photographic license disagrees with original-page evidence`);
  assert.equal(proof.licenseUrl, photo.licenseUrl, `${label}: license URL disagrees with original-page evidence`);
  if (photo.attribution) assert.ok(photo.credit.includes(photo.attribution), `${label}: preserve the photographer's requested credit`);
  if (proof.attribution && proof.attribution !== proof.author) assert.equal(photo.attribution, proof.attribution, `${label}: preserve the original attribution requirement`);
  if (photo.authorUrl) assertHttps(photo.authorUrl, label);
  assert.ok(Number.isInteger(proof.revisionId) && proof.revisionId > 0);
  assert.equal(photo.licenseEvidenceUrl, proof.sourceRevisionUrl, `${label}: cite the reviewed revision`);
  assert.equal(new URL(photo.licenseEvidenceUrl).searchParams.get('oldid'), String(proof.revisionId));
  const data = localFile(photo.file);
  assert.equal(data.length, photo.bytes, `${label}: byte metadata disagrees with the local photograph`);
  assert.deepEqual(jpegSize(data), [photo.width, photo.height], `${label}: dimensions disagree with local JPEG`);
  assert.ok(photo.width >= 400 && photo.height >= 400, `${label}: insufficient usable photographic resolution`);
}

test('118 distinct world destinations cover six inhabited continents and 85 foreign countries', () => {
  assert.equal(worldPlaces.length, 118);
  assert.equal(ids.size, 118);
  assert.equal(countryNames.length, 85);
  assert.deepEqual(new Set(manifest.map(p => p.id)), ids, 'The photography discovery manifest must match the published destination set');
  assert.deepEqual(new Set(worldPlaces.map(p => p.country)), new Set(countryNames));
  assert.deepEqual(new Set(worldPlaces.map(p => p.continent)), new Set(['亚洲', '欧洲', '非洲', '北美洲', '南美洲', '大洋洲']));
  assert.equal(chinaPlaces.length, 81, 'The Chinese destination set must retain all 81 entries');
  const chinaIds = new Set(chinaPlaces.map(p => p.id));
  assert.ok(worldPlaces.every(p => !chinaIds.has(p.id) && p.country !== '中国'));
});

test('world destinations have valid WGS84 points and complete compatible editorial fields', () => {
  const themeIds = new Set(themes.map(t => t.id));
  for (const p of worldPlaces) {
    assert.match(p.id, /^world-[a-z-]+$/);
    assert.ok(Array.isArray(p.coordinate) && p.coordinate.length === 2 && p.coordinate.every(Number.isFinite), `${p.id}: invalid WGS84 coordinate`);
    assert.ok(Math.abs(p.coordinate[0]) <= 180 && Math.abs(p.coordinate[1]) < 85, `${p.id}: coordinate outside map bounds`);
    assert.ok(p.zoom >= 6 && p.zoom <= 16 && p.pitch >= 0 && p.pitch <= 75, `${p.id}: unusable camera`);
    assert.equal(p.province, p.country, `${p.id}: existing catalogue filter must use the country`);
    assert.ok(themeIds.has(p.theme), `${p.id}: theme must use the existing eight IDs`);
    assert.ok(['nature', 'culture'].includes(p.category));
    for (const key of ['name', 'en', 'country', 'continent', 'region', 'kicker', 'title', 'description']) assert.ok(p[key]?.trim(), `${p.id}: missing ${key}`);
    assert.equal(p.paragraphs.length, 2);
    assert.ok(p.paragraphs.every(text => text.length >= 70), `${p.id}: needs substantial geographic and cultural/ecological reading`);
    assert.equal(p.stats.length, 3);
    assert.ok(p.stats.every(s => s.value?.trim() && s.label?.trim()));
    assert.ok(p.tags.length >= 3 && p.aliases.length >= 1);
    assert.equal(p.image, `./images/${p.id}.jpg`);
    assert.ok(p.source.label?.trim());
    assertHttps(p.source.url, p.id);
    if (p.theme === 'cities') assert.equal(p.terrain, false, `${p.id}: avoid DTM building artifacts for city views`);
  }
});

test('each world place has two distinct reading headings and a specific observation passage', () => {
  assert.deepEqual(new Set(Object.keys(worldStories)), ids);
  for (const p of worldPlaces) {
    const story = worldStories[p.id];
    assert.equal(story.chapterTitles.length, p.paragraphs.length);
    assert.equal(new Set(story.chapterTitles).size, 2);
    assert.ok(story.chapterTitles.every(t => t.length >= 6 && t.length <= 14));
    assert.ok(story.observation.length >= 70 && story.observation.length <= 110);
    assert.ok(!p.paragraphs.includes(story.observation), `${p.id}: observation must add a new way to read the landscape`);
  }
});

test('world sources are deduplicated and all theme routes lead to real discoverable destinations', () => {
  assert.deepEqual(new Set(worldSources.map(s => s.url)), new Set(worldPlaces.map(p => p.source.url)));
  assert.equal(worldSources.length, new Set(worldSources.map(s => s.url)).size);
  assert.equal(new Set(worldChapters.map(c => c.id)).size, worldChapters.length);
  const reachable = new Set();
  for (const chapter of worldChapters) {
    for (const key of ['id', 'label', 'en', 'title', 'intro', 'number']) assert.ok(chapter[key]?.trim());
    assert.ok(chapter.placeIds.length >= 3 && chapter.placeIds.length <= 12);
    assert.equal(new Set(chapter.placeIds).size, chapter.placeIds.length);
    for (const id of chapter.placeIds) {
      assert.ok(ids.has(id), `${chapter.id}: unknown world destination ${id}`);
      reachable.add(id);
    }
  }
  assert.deepEqual(reachable, ids, 'Every world destination must occur in at least one journey');
});

test('all world covers are real local JPEGs with matching 480px WebP thumbnails and explicit licenses', () => {
  assert.deepEqual(new Set(Object.keys(covers)), ids);
  for (const p of worldPlaces) {
    const photo = covers[p.id];
    assertPhoto(photo, `${p.id} cover`);
    assert.equal(photo.id, p.id);
    assert.equal(photo.file, p.image.slice(1));
    const thumb = readFileSync(new URL(`../public/images/thumbs/${p.id}.webp`, import.meta.url));
    assert.equal(webpSize(thumb)[0], 480, `${p.id}: thumbnail must be exactly 480px wide`);
  }
  assert.equal(covers['world-eiffel'].license, 'CC BY-SA 3.0', 'Do not confuse the public-domain building with the copyrighted photograph');
});

test('all world detail photographs are distinct, captioned, local and independently licensed', () => {
  assert.equal(details.length, worldPlaces.length);
  assert.deepEqual(new Set(details.map(p => p.id)), ids);
  assert.equal(new Set([...Object.values(covers), ...details].map(p => p.sourceUrl)).size, worldPlaces.length * 2, 'Every cover and detail must use a distinct original photograph');
  for (const photo of details) {
    assertPhoto(photo, `${photo.id} detail`);
    assert.match(photo.file, /^\/images\/details\/world-[a-z-]+\.jpg$/);
    assert.ok(photo.caption?.trim() && photo.alt?.trim(), `${photo.id}: missing explanatory caption or accessible text`);
    assert.notEqual(decodeURI(photo.sourceUrl), decodeURI(covers[photo.id].sourceUrl), `${photo.id}: second photograph repeats its cover`);
  }
});
