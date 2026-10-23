import test from 'node:test';
import assert from 'node:assert/strict';
import { installTileProtocol, setDetailTileCoverage } from '../src/map-tiles.js';

const image = (bytes = [1, 2, 3], type = 'image/jpeg') => new Response(new Uint8Array(bytes), { headers: { 'content-type': type } });
const pause = () => new Promise(resolve => setImmediate(resolve));
const tile = (key = 'satellite/6/50/25') => ({ url: `atlas://${key}` });

function loader(fetch, options = {}) {
  setDetailTileCoverage();
  let handler;
  installTileProtocol({ addProtocol(name, callback) { assert.equal(name, 'atlas'); handler = callback; } }, {
    fetch, cacheStorage: null, baseURL: 'https://example.com/china-atlas/', ...options
  });
  return handler;
}

function deferredFetch() {
  const requests = [];
  return {
    requests,
    fetch(url, { signal }) {
      return new Promise((resolve, reject) => {
        requests.push({ url, signal, resolve, reject });
        signal.addEventListener('abort', () => reject(new DOMException('Aborted', 'AbortError')), { once: true });
      });
    }
  };
}

function cacheStorage() {
  const entries = new Map();
  const deletedNames = [];
  const cache = {
    async keys() { return [...entries.keys()].map(url => new Request(url)); },
    async match(request) { return entries.get(typeof request === 'string' ? request : request.url)?.clone(); },
    async put(url, response) { entries.delete(url); entries.set(url, response.clone()); },
    async delete(request) { return entries.delete(typeof request === 'string' ? request : request.url); }
  };
  return {
    entries, deletedNames,
    async open() { return cache; },
    async keys() { return ['shanhe-tiles:/china-atlas/:v0', 'unrelated-app-cache']; },
    async delete(name) { deletedNames.push(name); return true; }
  };
}

test('merges concurrent tile requests and returns independent buffers', async () => {
  const network = deferredFetch();
  const get = loader(network.fetch);
  const first = get(tile(), new AbortController());
  const second = get(tile(), new AbortController());
  await pause();
  assert.equal(network.requests.length, 1);
  network.requests[0].resolve(image());
  const [a, b] = await Promise.all([first, second]);
  assert.notEqual(a.data, b.data);
  new Uint8Array(a.data)[0] = 99;
  assert.equal(new Uint8Array(b.data)[0], 1);
  const cached = await get(tile(), new AbortController());
  assert.equal(new Uint8Array(cached.data)[0], 1);
  assert.equal(network.requests.length, 1);
});

test('one consumer cancelling does not cancel another consumer', async () => {
  const network = deferredFetch();
  const get = loader(network.fetch);
  const firstController = new AbortController();
  const first = get(tile(), firstController);
  const cancelled = assert.rejects(first, { name: 'AbortError' });
  const second = get(tile(), new AbortController());
  await pause();
  firstController.abort();
  await cancelled;
  assert.equal(network.requests[0].signal.aborted, false);
  network.requests[0].resolve(image());
  assert.equal((await second).data.byteLength, 3);
});

test('last consumer cancelling aborts the network, does not cache, and permits retry', async () => {
  const network = deferredFetch();
  const get = loader(network.fetch);
  const controller = new AbortController();
  const cancelled = assert.rejects(get(tile(), controller), { name: 'AbortError' });
  await pause();
  controller.abort();
  await cancelled;
  assert.equal(network.requests[0].signal.aborted, true);
  const retry = get(tile(), new AbortController());
  await pause();
  assert.equal(network.requests.length, 2);
  network.requests[1].resolve(image());
  await retry;
});

test('memory uses byte capacity and least recently used eviction', async () => {
  const calls = [];
  const get = loader(async url => { calls.push(url); return image([1, 2, 3, 4]); }, { maxMemoryBytes: 8 });
  const a = tile('satellite/6/50/25');
  const b = tile('satellite/6/51/25');
  const c = tile('satellite/6/52/25');
  await get(a);
  await get(b);
  await get(a); // A becomes the most recently used entry.
  await get(c);
  await get(a);
  assert.equal(calls.length, 3);
  await get(b);
  assert.equal(calls.length, 4);
  let oversizedCalls = 0;
  const uncached = loader(async () => { oversizedCalls++; return image([1, 2, 3, 4, 5]); }, { maxMemoryBytes: 4 });
  await uncached(a);
  await uncached(a);
  assert.equal(oversizedCalls, 2);
});

test('exact local coverage skips known missing tiles and preserves deployment subdirectories', async () => {
  const urls = [];
  const get = loader(async url => { urls.push(url); return image(); });
  for (const key of ['satellite/4/0/15', 'satellite/5/20/7', 'relief/5/31/17', 'terrain/4/15/0']) await get(tile(key));
  assert.deepEqual(urls, [
    'https://example.com/china-atlas/tiles/satellite/4/0/15.jpg',
    'https://example.com/china-atlas/tiles/satellite/5/20/7.jpg',
    'https://example.com/china-atlas/tiles/relief/5/31/17.jpg',
    'https://example.com/china-atlas/tiles/terrain-webp/4/15/0.webp'
  ]);
  urls.length = 0;
  for (const key of ['satellite/5/19/7', 'satellite/5/20/6', 'terrain/5/20/18', 'relief/6/50/25']) await get(tile(key));
  assert.equal(urls.length, 4);
  assert.ok(urls.every(url => !url.startsWith('https://example.com/')));
  assert.ok(urls[2].endsWith('/terrarium/5/20/18.png'));
});

test('detail manifest enables only its precise high zoom tile keys', async () => {
  const urls = [];
  const get = loader(async url => { urls.push(url); return image(); });
  setDetailTileCoverage({ satellite: ['6/50/25'], terrain: ['7/100/50'] });
  await get(tile());
  await get(tile('terrain/7/100/50'));
  await get(tile('satellite/6/51/25'));
  assert.ok(urls[0].endsWith('/china-atlas/tiles/satellite/6/50/25.jpg'));
  assert.ok(urls[1].endsWith('/china-atlas/tiles/terrain-webp/7/100/50.webp'));
  assert.ok(urls[2].includes('arcgisonline.com'));
});

test('pending detail coverage delays only unknown detail tiles and preserves immediate overview loading', async () => {
  let resolveCoverage;
  const coverage = new Promise(resolve => { resolveCoverage = resolve; });
  let coverageCalls = 0;
  const urls = [];
  const get = loader(async url => { urls.push(url); return image(); }, {
    detailCoverageReady: () => { coverageCalls++; return coverage; }
  });
  const detail = get(tile());
  const overview = get(tile('satellite/4/0/15'));
  await pause();
  assert.equal(coverageCalls, 1);
  assert.deepEqual(urls, ['https://example.com/china-atlas/tiles/satellite/4/0/15.jpg']);
  assert.equal((await overview).data.byteLength, 3);
  setDetailTileCoverage({ satellite: ['6/50/25'] });
  resolveCoverage();
  assert.equal((await detail).data.byteLength, 3);
  assert.deepEqual(urls, [
    'https://example.com/china-atlas/tiles/satellite/4/0/15.jpg',
    'https://example.com/china-atlas/tiles/satellite/6/50/25.jpg'
  ]);
  await get(tile('satellite/4/1/15'));
  assert.equal(coverageCalls, 1);
});

test('a tile cancelled while waiting for detail coverage never fetches and permits a local retry', async () => {
  let resolveCoverage;
  const coverage = new Promise(resolve => { resolveCoverage = resolve; });
  const urls = [];
  const get = loader(async url => { urls.push(url); return image(); }, { detailCoverageReady: () => coverage });
  const controller = new AbortController();
  const cancelled = assert.rejects(get(tile(), controller), { name: 'AbortError' });
  controller.abort();
  await cancelled;
  setDetailTileCoverage({ satellite: ['6/50/25'] });
  resolveCoverage();
  await pause();
  assert.deepEqual(urls, []);
  assert.equal((await get(tile())).data.byteLength, 3);
  assert.deepEqual(urls, ['https://example.com/china-atlas/tiles/satellite/6/50/25.jpg']);
});

test('failed detail coverage still permits the original remote fallback', async () => {
  const urls = [];
  const get = loader(async url => { urls.push(url); return image(); }, {
    detailCoverageReady: () => Promise.reject(new Error('Coverage temporarily unavailable'))
  });
  assert.equal((await get(tile())).data.byteLength, 3);
  assert.equal(urls.length, 1);
  assert.ok(urls[0].includes('arcgisonline.com'));
});

test('an unavailable local tile falls back to its original remote source', async () => {
  const urls = [];
  const get = loader(async url => {
    urls.push(url);
    return url.startsWith('https://example.com/') ? new Response('Missing', { status: 404 }) : image();
  });
  await get(tile('terrain/3/6/3'));
  assert.deepEqual(urls, [
    'https://example.com/china-atlas/tiles/terrain-webp/3/6/3.webp',
    'https://s3.amazonaws.com/elevation-tiles-prod/terrarium/3/6/3.png'
  ]);
});

test('HTTP errors and invalid tile responses are not cached and remain retryable', async () => {
  const storage = cacheStorage();
  let count = 0;
  const get = loader(async () => {
    count++;
    if (count === 1) return new Response('Unavailable', { status: 503 });
    if (count === 2) return new Response('<html>fallback</html>', { headers: { 'content-type': 'text/html' } });
    return image();
  }, { cacheStorage: storage });
  await assert.rejects(get(tile()), /Tile HTTP 503/);
  await assert.rejects(get(tile()), /Invalid tile content/);
  await pause();
  assert.equal(storage.entries.size, 0);
  await get(tile());
  await pause();
  assert.equal(count, 3);
  assert.equal(storage.entries.size, 1);
});

test('only remote successes persist; persistent cache survives a new loader and stays bounded', async () => {
  const storage = cacheStorage();
  let count = 0;
  const fetch = async () => { count++; return image([1, 2, 3, 4]); };
  const options = { cacheStorage: storage, maxPersistentTiles: 10, maxPersistentBytes: 8 };
  const get = loader(fetch, options);
  await get(tile('satellite/4/0/0'));
  await pause();
  assert.equal(storage.entries.size, 0);
  await get(tile());
  await pause();
  assert.equal(storage.entries.size, 1);
  const fromDisk = loader(fetch, options);
  await fromDisk(tile());
  assert.equal(count, 2);
  await get(tile('satellite/6/51/25'));
  await get(tile('satellite/6/52/25'));
  await pause();
  assert.equal(storage.entries.size, 2);
  assert.equal(storage.entries.has('https://server.arcgisonline.com/ArcGIS/rest/services/World_Imagery/MapServer/tile/6/25/50'), false);
  assert.deepEqual(storage.deletedNames, ['shanhe-tiles:/china-atlas/:v0', 'shanhe-tiles:/china-atlas/:v0']);
});

test('persistent tile count is capped independently of byte capacity', async () => {
  const storage = cacheStorage();
  const get = loader(async () => image(), { cacheStorage: storage, maxPersistentTiles: 2 });
  for (const x of [50, 51, 52]) await get(tile(`satellite/6/${x}/25`));
  await pause();
  assert.equal(storage.entries.size, 2);
});

test('cancelled remote work never reaches persistent storage', async () => {
  const storage = cacheStorage();
  const network = deferredFetch();
  const get = loader(network.fetch, { cacheStorage: storage });
  const controller = new AbortController();
  const cancelled = assert.rejects(get(tile(), controller), { name: 'AbortError' });
  await pause();
  controller.abort();
  await cancelled;
  await pause();
  assert.equal(storage.entries.size, 0);
});

test('cache storage failures do not prevent normal network loading', async () => {
  const get = loader(async () => image(), { cacheStorage: { async open() { throw new Error('Quota/security restriction'); } } });
  assert.equal((await get(tile())).data.byteLength, 3);
});

test('remote requests time out and a later request can succeed', async () => {
  const network = deferredFetch();
  const get = loader(network.fetch, { timeoutMs: 15 });
  await assert.rejects(get(tile()), /Tile request timed out/);
  assert.equal(network.requests[0].signal.aborted, true);
  const retry = get(tile());
  await pause();
  network.requests[1].resolve(image());
  await retry;
});

test('invalid coordinates and already aborted consumers never reach the network', async () => {
  let calls = 0;
  const get = loader(async () => { calls++; return image(); });
  for (const url of ['atlas://satellite/3/8/0', 'atlas://terrain/23/0/0', 'atlas://other/3/1/1', 'atlas://satellite/3/1/1/trailing']) {
    await assert.rejects(get({ url }), /Invalid tile/);
  }
  const controller = new AbortController();
  controller.abort();
  await assert.rejects(get(tile(), controller), { name: 'AbortError' });
  assert.equal(calls, 0);
});
