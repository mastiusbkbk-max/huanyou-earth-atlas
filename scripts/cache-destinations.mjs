import { mkdir, stat, writeFile, copyFile, rm, mkdtemp } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { tmpdir } from 'node:os';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { places, highlights } from '../src/content.js';
import { realScenes } from '../src/real-scene.js';

const run = promisify(execFile);
const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const manifestPath = join(root, 'public/data/tiles-detail.json');
const temporary = await mkdtemp(join(tmpdir(), 'shanhe-detail-tiles-'));
const byteLimit = 200_000_000;
const deadline = Date.now() + Number(process.env.ATLAS_CACHE_SECONDS || 390) * 1000;
const concurrency = 8;
const requested = new Map();
const longitudeTile = (longitude, zoom) => Math.min(2 ** zoom - 1, Math.max(0, Math.floor((longitude + 180) / 360 * 2 ** zoom)));
const latitudeTile = (latitude, zoom) => Math.min(2 ** zoom - 1, Math.max(0, Math.floor((1 - Math.asinh(Math.tan(latitude * Math.PI / 180)) / Math.PI) / 2 * 2 ** zoom)));

function add(type, zoom, x, y) {
  if (zoom < 6 || x < 0 || y < 0 || x >= 2 ** zoom || y >= 2 ** zoom) return;
  const key = `${zoom}/${x}/${y}`;
  requested.set(`${type}/${key}`, { type, key, zoom, x, y });
}

// Measured Everest landing: supplement the coordinate-based neighborhood.
for (let x = 1516; x <= 1519; x++) for (let y = 856; y <= 858; y++) {
  add('terrain', 11, x, y);
  add('satellite', 11, x, y);
}
for (let x = 3032; x <= 3035; x++) for (let y = 1717; y <= 1720; y++) add('satellite', 12, x, y);
// Measured intermediate tiles along the overview-to-Everest flight.
for (const [zoom, xMin, xMax, yMin, yMax] of [[6, 44, 51, 24, 29], [7, 92, 96, 51, 54], [8, 186, 191, 105, 107]]) {
  for (const type of ['satellite', 'terrain']) {
    for (let x = xMin; x <= xMax; x++) for (let y = yMin; y <= yMax; y++) add(type, zoom, x, y);
  }
}

const orderedPlaces = [...places].sort((a, b) => Number(highlights.includes(b.id)) - Number(highlights.includes(a.id)));
for (const place of orderedPlaces) {
  const radius = highlights.includes(place.id) ? 2 : 1;
  for (const type of ['satellite', 'terrain']) {
    for (const zoom of [6, 7, 8]) {
      const x = longitudeTile(place.coordinate[0], zoom);
      const y = latitudeTile(place.coordinate[1], zoom);
      for (let dx = -radius; dx <= radius; dx++) for (let dy = -radius; dy <= radius; dy++) add(type, zoom, x + dx, y + dy);
    }
  }
  const terrainZoom = Math.min(14, Math.floor(place.zoom));
  for (const [type, zooms] of [['satellite', [Math.round(place.zoom + 1)]], ['terrain', [terrainZoom, terrainZoom - 1, Math.min(14, Math.round(place.zoom + 1))]]]) {
    for (const zoom of zooms) {
      const x = longitudeTile(place.coordinate[0], zoom);
      const y = latitudeTile(place.coordinate[1], zoom);
      for (let dx = -radius; dx <= radius; dx++) for (let dy = -radius; dy <= radius; dy++) add(type, zoom, x + dx, y + dy);
    }
  }
}

// Satellite context for the published Hong Kong 3D scenes.
for (const scene of realScenes) {
  for (const [zoom, radius] of [[14, 1], [15, 2], [16, 3], [17, 4]]) {
    const x = longitudeTile(scene.center[0], zoom);
    const y = latitudeTile(scene.center[1], zoom);
    for (let dx = -radius; dx <= radius; dx++) for (let dy = -radius; dy <= radius; dy++) add('satellite', zoom, x + dx, y + dy);
  }
  if (scene.terrain) {
    for (const zoom of [13, 14]) {
      const x = longitudeTile(scene.center[0], zoom), y = latitudeTile(scene.center[1], zoom);
      for (let dx = -1; dx <= 1; dx++) for (let dy = -1; dy <= 1; dy++) add('terrain', zoom, x + dx, y + dy);
    }
  }
}

const jobs = [...requested.values()];
const successful = { satellite: new Set(), terrain: new Set() };
const failures = [];
const bytes = { satellite: 0, terrain: 0, total: 0 };
let cursor = 0;
let attempted = 0;
let skippedExisting = 0;
let budgetReached = false;
let reservedBytes = 0;
const conversion = `from PIL import Image
import sys
with Image.open(sys.argv[1]) as source:
    rgb = source.convert('RGB')
    rgb.save(sys.argv[2], format='WEBP', lossless=True, method=6, exact=True)
    with Image.open(sys.argv[2]) as result:
        if rgb.size != result.size or rgb.tobytes() != result.convert('RGB').tobytes():
            raise ValueError('Lossless DEM verification failed')
`;

function destination(job) {
  return join(root, 'public/tiles', job.type === 'terrain' ? 'terrain-webp' : 'satellite', `${job.key}.${job.type === 'terrain' ? 'webp' : 'jpg'}`);
}

async function existingSize(path) {
  try {
    const size = (await stat(path)).size;
    if (size > 0) return size;
  } catch {}
  return 0;
}

function record(job, size) {
  if (successful[job.type].has(job.key)) return;
  successful[job.type].add(job.key);
  bytes[job.type] += size;
  bytes.total += size;
}

try {
  // Inventory all previously completed jobs before enforcing the new-download budget.
  const remaining = [];
  for (const job of jobs) {
    const size = await existingSize(destination(job));
    if (size) { record(job, size); skippedExisting++; }
    else remaining.push(job);
  }
  console.log(JSON.stringify({ requested: jobs.length, existing: skippedExisting, remaining: remaining.length, concurrency, byteLimit }));
  await Promise.all(Array.from({ length: concurrency }, async (_, worker) => {
    while (cursor < remaining.length && Date.now() < deadline && !budgetReached) {
      const job = remaining[cursor++];
      const raw = join(temporary, `${worker}.${job.type === 'terrain' ? 'png' : 'jpg'}`);
      const converted = join(temporary, `${worker}.webp`);
      const url = job.type === 'terrain'
        ? `https://s3.amazonaws.com/elevation-tiles-prod/terrarium/${job.key}.png`
        : `https://server.arcgisonline.com/ArcGIS/rest/services/World_Imagery/MapServer/tile/${job.zoom}/${job.y}/${job.x}`;
      try {
        await run('curl', ['--fail', '--silent', '--show-error', '--connect-timeout', '8', '--max-time', '15', '--retry', '1', '--retry-delay', '0', '--output', raw, url], { timeout: 32_000 });
        if (job.type === 'terrain') await run('/usr/bin/python3', ['-c', conversion, raw, converted], { timeout: 30_000 });
        const source = job.type === 'terrain' ? converted : raw;
        const size = (await stat(source)).size;
        if (!size) throw new Error('Empty tile');
        if (bytes.total + reservedBytes + size > byteLimit) { budgetReached = true; continue; }
        const target = destination(job);
        reservedBytes += size;
        try {
          await mkdir(dirname(target), { recursive: true });
          await copyFile(source, target);
          record(job, size);
        } finally { reservedBytes -= size; }
      } catch (error) {
        failures.push({ type: job.type, key: job.key, message: String(error.stderr || error.message).trim().slice(-300) });
      }
      attempted++;
      if (attempted % 100 === 0) console.log(JSON.stringify({ attempted, successful: successful.satellite.size + successful.terrain.size, bytes: bytes.total, failures: failures.length, pending: remaining.length - cursor }));
    }
  }));
  const sortKeys = (a, b) => a.localeCompare(b, 'en', { numeric: true });
  const tiles = { satellite: successful.satellite.size, terrain: successful.terrain.size, relief: 0 };
  tiles.total = tiles.satellite + tiles.terrain;
  const manifest = {
    version: 1,
    generatedAt: new Date().toISOString(),
    satellite: [...successful.satellite].sort(sortKeys),
    terrain: [...successful.terrain].sort(sortKeys),
    relief: [],
    bytes,
    tiles,
    requested: jobs.length,
    pending: jobs.length - tiles.total - failures.length,
    failures,
    budgetReached,
    byteLimit,
    sources: {
      satellite: { provider: 'Esri World Imagery', url: 'https://server.arcgisonline.com/ArcGIS/rest/services/World_Imagery/MapServer/tile/{z}/{y}/{x}', attribution: 'Esri, Vantor, Earthstar Geographics, and the GIS User Community', format: 'Original JPEG' },
      terrain: { provider: 'Mapzen / AWS Terrain Tiles', url: 'https://s3.amazonaws.com/elevation-tiles-prod/terrarium/{z}/{x}/{y}.png', encoding: 'terrarium', format: 'Lossless WebP; decoded RGB pixels verified equal to source PNG' },
    },
    coverage: {
      places: places.length,
      highlightedPlaces: highlights.length,
      minimumZoom: 6,
      satelliteZoom: 'round(place.zoom + 1)',
      terrainZooms: 'floor(place.zoom), floor(place.zoom) - 1, min(14, round(place.zoom + 1)); final level preserves independent hillshade detail',
      intermediateZooms: [6, 7, 8],
      neighborhood: '3 by 3 around each representative coordinate; 5 by 5 for highlighted places',
      measuredSupplement: 'Everest terrain z11 x1516-1519 y856-858; satellite same z11 range and z12 x3032-3035 y1717-1720',
      measuredFlightSupplement: 'Satellite and terrain: z6 x44-51 y24-29; z7 x92-96 y51-54; z8 x186-191 y105-107; recorded during the overview-to-Everest flight',
      hongKongRealSceneSupplement: {
        centers: realScenes.map(scene => scene.center),
        scenes: realScenes.map(({ id, name, center }) => ({ id, name, center })),
        satelliteNeighborhoods: { 14: '3 by 3', 15: '5 by 5', 16: '7 by 7', 17: '9 by 9' },
        note: 'Sparse original JPEG satellite surroundings for the published Hong Kong real-scene cameras; this does not imply complete offline map coverage.',
      },
      note: 'Sparse center coverage speeds common destination landings; it does not cover every flight path, tilted viewport, nearby pan, or zoom level. Unlisted tiles require the original online providers. Existing overview cache z0-5 is separate.',
    },
  };
  await writeFile(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`);
  console.log(JSON.stringify({ tiles, bytes, requested: jobs.length, pending: manifest.pending, failures: failures.length, budgetReached, manifest: manifestPath }));
} finally {
  await rm(temporary, { recursive: true, force: true });
}
