import { constants } from 'node:fs';
import { copyFile, mkdir, mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { execFile } from 'node:child_process';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
import { worldPlaces } from '../src/content-world.js';
import { worldScenes } from '../src/world-scenes.js';

const run = promisify(execFile);
const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const byteLimit = 200_000_000;
const concurrency = 10;
const reportPath = join(root, 'artifacts/world-cache-results.json');
const baselinePath = join(root, 'artifacts/world-cache-baseline.json');
const detailPath = join(root, 'public/data/tiles-detail.json');
const temporary = await mkdtemp(join(tmpdir(), 'atlas-world-cache-'));
const requested = new Map();
const placeCoverage = [];
const countryCoverage = [];
const sceneCoverage = worldScenes.map(scene => ({ id: scene.id, name: scene.name, coordinate: scene.center, zoom: scene.zoom, terrainEnabled: scene.terrain === true }));
const hash = value => createHash('sha256').update(value).digest('hex');
const tilePath = (type, key) => `public/tiles/${type === 'terrain' ? 'terrain-webp' : type}/${key}.${type === 'terrain' ? 'webp' : 'jpg'}`;
const tileXY = ([longitude, latitude], zoom) => {
  const size = 2 ** zoom;
  const limitedLatitude = Math.max(-85.05112878, Math.min(85.05112878, latitude));
  return [Math.min(size - 1, Math.max(0, Math.floor((longitude + 180) / 360 * size))),
    Math.min(size - 1, Math.max(0, Math.floor((1 - Math.asinh(Math.tan(limitedLatitude * Math.PI / 180)) / Math.PI) / 2 * size)))];
};

function neighborhood(type, coordinate, zoom) {
  const [centerX, centerY] = tileXY(coordinate, zoom);
  const keys = [];
  for (let dx = -1; dx <= 1; dx++) for (let dy = -1; dy <= 1; dy++) {
    const y = centerY + dy;
    if (y < 0 || y >= 2 ** zoom) continue;
    const x = (centerX + dx + 2 ** zoom) % 2 ** zoom;
    const key = `${zoom}/${x}/${y}`;
    requested.set(`${type}/${key}`, { type, key, zoom, x, y });
    keys.push(key);
  }
  return keys;
}

for (const place of worldPlaces) {
  const satellite = [...new Set([Math.floor(place.zoom), Math.round(place.zoom + 1)])]
    .flatMap(zoom => neighborhood('satellite', place.coordinate, zoom));
  const terrainZoom = Math.min(14, Math.floor(place.zoom));
  const terrain = place.terrain === false ? [] : [terrainZoom, terrainZoom - 1]
    .flatMap(zoom => neighborhood('terrain', place.coordinate, zoom));
  placeCoverage.push({ id: place.id, name: place.name, coordinate: place.coordinate, satellite, terrain });
}
for (const scene of sceneCoverage) {
  scene.satellite = [];
  for (let zoom = 14; zoom <= Math.max(18, Math.round(scene.zoom + 1)); zoom++) {
    scene.satellite.push(...neighborhood('satellite', scene.coordinate, zoom));
  }
  scene.terrain = scene.terrainEnabled ? [13, 14].flatMap(zoom => neighborhood('terrain', scene.coordinate, zoom)) : [];
}
// Country filters land at zoom 5–5.5; use the same Mercator bounds center.
for (const country of new Set(worldPlaces.map(place => place.country))) {
  const points = worldPlaces.filter(place => place.country === country).map(place => place.coordinate);
  const longitudes = points.map(point => point[0]);
  const latitudes = points.map(point => Math.asinh(Math.tan(point[1] * Math.PI / 180)));
  const coordinate = [(Math.min(...longitudes) + Math.max(...longitudes)) / 2,
    Math.atan(Math.sinh((Math.min(...latitudes) + Math.max(...latitudes)) / 2)) * 180 / Math.PI];
  countryCoverage.push({ country, coordinate,
    satellite: [5, 6].flatMap(zoom => neighborhood('satellite', coordinate, zoom)),
    terrain: [5, 6].flatMap(zoom => neighborhood('terrain', coordinate, zoom)),
  });
}

const validate = `from PIL import Image
import sys
with Image.open(sys.argv[1]) as im:
    im.load()
    expected = 'JPEG' if sys.argv[2] == 'satellite' else 'WEBP'
    if im.format != expected or im.size != (256,256):
        raise ValueError(f'Expected {expected} 256x256, got {im.format} {im.size}')
`;
const convert = `from PIL import Image
import sys
with Image.open(sys.argv[1]) as source:
    source.load()
    if source.format != 'PNG' or source.size != (256,256):
        raise ValueError('Expected Terrarium PNG 256x256')
    rgb = source.convert('RGB')
    rgb.save(sys.argv[2], format='WEBP', lossless=True, method=6, exact=True)
    with Image.open(sys.argv[2]) as result:
        result.load()
        if result.format != 'WEBP' or result.size != (256,256) or rgb.tobytes() != result.convert('RGB').tobytes():
            raise ValueError('Terrarium RGB pixel equality failed')
`;

async function verifyBaseline(baseline) {
  if (hash(await readFile(detailPath)) !== baseline.manifest.sha256) throw new Error('Existing detail manifest changed');
  for (const file of baseline.files) {
    if (hash(await readFile(join(root, file.path))) !== file.sha256) throw new Error(`Existing tile changed: ${file.path}`);
  }
}

try {
  await mkdir(dirname(reportPath), { recursive: true });
  let baseline;
  try { baseline = JSON.parse(await readFile(baselinePath, 'utf8')); } catch (error) {
    if (error.code !== 'ENOENT') throw error;
    const manifestBytes = await readFile(detailPath);
    const detail = JSON.parse(manifestBytes);
    const files = [];
    for (const type of ['satellite', 'terrain', 'relief']) for (const key of detail[type]) {
      const path = tilePath(type, key);
      const data = await readFile(join(root, path));
      files.push({ path, bytes: data.length, sha256: hash(data) });
    }
    baseline = { createdAt: new Date().toISOString(), manifest: { path: 'public/data/tiles-detail.json', bytes: manifestBytes.length, sha256: hash(manifestBytes) }, files };
    await writeFile(baselinePath, `${JSON.stringify(baseline, null, 2)}\n`, { flag: 'wx' });
  }
  await verifyBaseline(baseline);
  const priorReport = await readFile(reportPath, 'utf8').then(JSON.parse).catch(error => {
    if (error.code !== 'ENOENT') throw error;
    return {};
  });
  const createdFiles = new Map((priorReport.createdFiles || []).map(file => [file.path, file]));
  const successful = { satellite: new Set(), terrain: new Set() };
  const bytes = { satellite: 0, terrain: 0, total: 0 };
  const failures = [];
  const pending = [];
  const files = [];
  let addedBytes = [...createdFiles.values()].reduce((sum, file) => sum + file.bytes, 0);
  let reservedBytes = 0;
  let cursor = 0;
  let completed = 0;
  let reused = 0;
  let budgetReached = false;
  const jobs = [...requested.values()];
  console.log(JSON.stringify({ places: worldPlaces.length, requested: jobs.length, concurrency, byteLimit }));

  async function record(job, target) {
    const data = await readFile(target);
    successful[job.type].add(job.key);
    bytes[job.type] += data.length;
    bytes.total += data.length;
    const file = { type: job.type, key: job.key, path: tilePath(job.type, job.key), bytes: data.length, sha256: hash(data) };
    files.push(file);
    return file;
  }

  await Promise.all(Array.from({ length: concurrency }, async (_, worker) => {
    while (cursor < jobs.length) {
      const job = jobs[cursor++];
      const target = join(root, tilePath(job.type, job.key));
      try {
        const exists = await stat(target).then(() => true).catch(error => {
          if (error.code !== 'ENOENT') throw error;
          return false;
        });
        if (exists) {
          await run('python3', ['-c', validate, target, job.type], { timeout: 30_000 });
          await record(job, target);
          reused++;
        } else {
          const raw = join(temporary, `${worker}.${job.type === 'terrain' ? 'png' : 'jpg'}`);
          const converted = join(temporary, `${worker}.webp`);
          const url = job.type === 'terrain'
            ? `https://s3.amazonaws.com/elevation-tiles-prod/terrarium/${job.key}.png`
            : `https://server.arcgisonline.com/ArcGIS/rest/services/World_Imagery/MapServer/tile/${job.zoom}/${job.y}/${job.x}`;
          await run('curl', ['--fail', '--silent', '--show-error', '--connect-timeout', '8', '--max-time', '15', '--retry', '1', '--retry-delay', '0', '--output', raw, url], { timeout: 32_000 });
          if (job.type === 'terrain') await run('python3', ['-c', convert, raw, converted], { timeout: 30_000 });
          else await run('python3', ['-c', validate, raw, job.type], { timeout: 30_000 });
          const source = job.type === 'terrain' ? converted : raw;
          const size = (await stat(source)).size;
          if (addedBytes + reservedBytes + size > byteLimit) {
            budgetReached = true;
            pending.push({ type: job.type, key: job.key, reason: `${byteLimit / 1_000_000} MB new-file budget` });
          } else {
            reservedBytes += size;
            try {
              await mkdir(dirname(target), { recursive: true });
              await copyFile(source, target, constants.COPYFILE_EXCL);
              const file = await record(job, target);
              createdFiles.set(file.path, file);
              addedBytes += size;
            } finally { reservedBytes -= size; }
          }
        }
      } catch (error) {
        failures.push({ type: job.type, key: job.key, message: String(error.stderr || error.message).trim().slice(-400) });
      }
      completed++;
      if (completed % 100 === 0) console.log(JSON.stringify({ completed, successful: files.length, newBytes: addedBytes, failures: failures.length, pending: pending.length }));
    }
  }));
  await verifyBaseline(baseline);
  const sortKeys = (a, b) => a.localeCompare(b, 'en', { numeric: true });
  const tiles = { satellite: successful.satellite.size, terrain: successful.terrain.size, relief: 0, total: files.length };
  const manifest = {
    version: 1, generatedAt: new Date().toISOString(),
    satellite: [...successful.satellite].sort(sortKeys), terrain: [...successful.terrain].sort(sortKeys), relief: [],
    bytes, tiles, requested: jobs.length, pending: pending.length, failures, budgetReached, byteLimit,
    sources: {
      satellite: { provider: 'Esri World Imagery', url: 'https://server.arcgisonline.com/ArcGIS/rest/services/World_Imagery/MapServer/tile/{z}/{y}/{x}', attribution: 'Esri, Vantor, Earthstar Geographics, and the GIS User Community', format: 'Original JPEG; decoded as 256 by 256' },
      terrain: { provider: 'Mapzen / AWS Terrain Tiles', url: 'https://s3.amazonaws.com/elevation-tiles-prod/terrarium/{z}/{x}/{y}.png', encoding: 'terrarium', format: 'Lossless WebP; every decoded RGB pixel verified equal to source PNG on download' },
    },
    coverage: {
      places: worldPlaces.length,
      satelliteZooms: 'floor(place.zoom), round(place.zoom + 1)',
      terrainZooms: 'min(14, floor(place.zoom)) and one lower, when terrain is enabled',
      neighborhood: '3 by 3 around each representative coordinate; longitude wraps at the dateline',
      destinations: placeCoverage.map(place => ({ ...place,
        successfulSatellite: place.satellite.filter(key => successful.satellite.has(key)).length,
        successfulTerrain: place.terrain.filter(key => successful.terrain.has(key)).length,
      })),
      scenes: sceneCoverage.map(scene => ({ ...scene,
        successfulSatellite: scene.satellite.filter(key => successful.satellite.has(key)).length,
        successfulTerrain: scene.terrain.filter(key => successful.terrain.has(key)).length,
      })),
      countries: countryCoverage.map(country => ({ ...country,
        successfulSatellite: country.satellite.filter(key => successful.satellite.has(key)).length,
        successfulTerrain: country.terrain.filter(key => successful.terrain.has(key)).length,
      })),
      note: 'Sparse landing neighborhoods only. Flight paths, tilted viewport edges, pans and other zooms can require the original online providers. Existing global overview and China detail caches are separate.',
    },
  };
  await writeFile(join(root, 'public/data/tiles-world.json'), `${JSON.stringify(manifest, null, 2)}\n`);
  const report = { generatedAt: manifest.generatedAt, tiles, bytes, requested: jobs.length, pending, failures, reused, newBytes: addedBytes, byteLimit, budgetReached,
    preservedDetail: { manifestSha256: baseline.manifest.sha256, tiles: baseline.files.length, allHashesUnchanged: true },
    checks: { satelliteFormat: 'JPEG 256x256 decoded', terrainFormat: 'WebP 256x256 decoded; new downloads compared pixel-for-pixel with source PNG' },
    files, createdFiles: [...createdFiles.values()], coverage: manifest.coverage };
  await writeFile(reportPath, `${JSON.stringify(report, null, 2)}\n`);
  console.log(JSON.stringify({ tiles, bytes, requested: jobs.length, pending: pending.length, failures: failures.length, newBytes: addedBytes, preservedDetailTiles: baseline.files.length }));
} finally {
  await rm(temporary, { recursive: true, force: true });
}
