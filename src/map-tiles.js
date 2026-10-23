const sources = ['satellite', 'terrain', 'relief'];
let detailCoverage = Object.fromEntries(sources.map(source => [source, new Set()]));

export function setDetailTileCoverage(manifest = {}) {
  detailCoverage = Object.fromEntries(sources.map(source => [source, new Set(
    (Array.isArray(manifest[source]) ? manifest[source] : []).filter(key => /^\d+\/\d+\/\d+$/.test(key))
  )]));
}

function parseTile(url) {
  const match = /^atlas:\/\/(satellite|terrain|relief)\/(\d+)\/(\d+)\/(\d+)$/.exec(url);
  if (!match) throw new Error('Invalid tile URL');
  const [, source, zoom, column, row] = match;
  const [z, x, y] = [zoom, column, row].map(Number);
  if (z > 22 || x >= 2 ** z || y >= 2 ** z) throw new Error('Invalid tile coordinates');
  return { source, z, x, y, tile: `${z}/${x}/${y}`, key: `${source}/${z}/${x}/${y}` };
}

function localPath({ source, z, x, y, tile }) {
  // Matches scripts/cache-map.mjs: global z0–4, then 55°E–180°E / 20°S–70°N.
  const overview = z <= 4 || (z === 5 && x >= 20 && x <= 31 && y >= 7 && y <= 17);
  if (!overview && !detailCoverage[source].has(tile)) return null;
  if (source === 'terrain') return `./tiles/terrain-webp/${tile}.webp`;
  return `./tiles/${source}/${tile}.jpg`;
}

function remoteURL({ source, z, x, y }) {
  if (source === 'terrain') return `https://s3.amazonaws.com/elevation-tiles-prod/terrarium/${z}/${x}/${y}.png`;
  return `https://server.arcgisonline.com/ArcGIS/rest/services/${source === 'satellite' ? 'World_Imagery' : 'World_Shaded_Relief'}/MapServer/tile/${z}/${y}/${x}`;
}

function abortError() {
  return new DOMException('Tile request cancelled', 'AbortError');
}

export function installTileProtocol(maplibregl, options = {}) {
  const fetchTile = options.fetch ?? globalThis.fetch.bind(globalThis);
  const cacheStorage = options.cacheStorage === undefined ? globalThis.caches : options.cacheStorage;
  const baseURL = options.baseURL ?? globalThis.document?.baseURI ?? globalThis.location?.href ?? 'http://localhost/';
  const memoryLimit = options.maxMemoryBytes ?? 32 * 1024 * 1024;
  const diskLimit = options.maxPersistentBytes ?? 64 * 1024 * 1024;
  const diskTileLimit = options.maxPersistentTiles ?? 400;
  const timeoutMs = options.timeoutMs ?? 12000;
  const cachePrefix = `shanhe-tiles:${new URL('./', baseURL).pathname}:`;
  const cacheName = `${cachePrefix}v1`;
  const memory = new Map();
  const inFlight = new Map();
  let memoryBytes = 0;
  let diskBytes = 0;
  let cachePromise;
  let diskIndexPromise;
  let diskQueue = Promise.resolve();

  function remember(key, data) {
    if (data.byteLength > memoryLimit) return;
    if (memory.has(key)) memoryBytes -= memory.get(key).byteLength;
    memory.delete(key);
    memory.set(key, data);
    memoryBytes += data.byteLength;
    while (memoryBytes > memoryLimit) {
      const oldest = memory.keys().next().value;
      memoryBytes -= memory.get(oldest).byteLength;
      memory.delete(oldest);
    }
  }

  async function trimDisk(cache, index) {
    while (index.size > diskTileLimit || diskBytes > diskLimit) {
      const [url, bytes] = index.entries().next().value;
      await cache.delete(url);
      index.delete(url);
      diskBytes -= bytes;
    }
  }

  function diskIndex(cache) {
    diskIndexPromise ??= (async () => {
      const index = new Map();
      const requests = await cache.keys();
      const responses = await Promise.all(requests.map(request => cache.match(request)));
      for (let i = 0; i < requests.length; i++) {
        const bytes = Number(responses[i]?.headers.get('x-atlas-bytes'));
        if (bytes > 0 && Number.isFinite(bytes)) {
          index.set(requests[i].url, bytes);
          diskBytes += bytes;
        } else await cache.delete(requests[i]);
      }
      await trimDisk(cache, index);
      return index;
    })();
    return diskIndexPromise;
  }

  function persistentCache() {
    if (!cacheStorage) return Promise.resolve(null);
    cachePromise ??= (async () => {
      try {
        const cache = await cacheStorage.open(cacheName);
        // Maintenance stays off the foreground tile lookup path.
        diskIndex(cache).catch(() => {});
        cacheStorage.keys().then(names => Promise.all(names
          .filter(name => name.startsWith(cachePrefix) && name !== cacheName)
          .map(name => cacheStorage.delete(name)))).catch(() => {});
        return cache;
      } catch { return null; }
    })();
    return cachePromise;
  }

  function persist(url, data, contentType, signal) {
    if (!cacheStorage || data.byteLength > diskLimit) return;
    diskQueue = diskQueue.then(async () => {
      const cache = await persistentCache();
      if (!cache || signal.aborted) return;
      const index = await diskIndex(cache);
      if (signal.aborted) return;
      await cache.put(url, new Response(data, { headers: {
        'content-type': contentType, 'x-atlas-bytes': String(data.byteLength)
      } }));
      if (signal.aborted) { await cache.delete(url); return; }
      diskBytes -= index.get(url) ?? 0;
      index.delete(url);
      index.set(url, data.byteLength);
      diskBytes += data.byteLength;
      await trimDisk(cache, index);
    }).catch(() => {});
  }

  async function request(url, signal) {
    const controller = new AbortController();
    const cancel = () => controller.abort();
    if (signal.aborted) throw abortError();
    signal.addEventListener('abort', cancel, { once: true });
    let timedOut = false;
    const timer = setTimeout(() => { timedOut = true; controller.abort(); }, timeoutMs);
    try {
      const response = await fetchTile(url, { signal: controller.signal });
      if (!response.ok) throw new Error(`Tile HTTP ${response.status}: ${url}`);
      const contentType = response.headers.get('content-type') ?? '';
      if (!contentType.startsWith('image/')) throw new Error(`Invalid tile content: ${url}`);
      const data = await response.arrayBuffer();
      if (signal.aborted) throw abortError();
      if (timedOut) throw new Error(`Tile request timed out: ${url}`);
      if (!data.byteLength) throw new Error(`Empty tile: ${url}`);
      return { data, contentType };
    } catch (error) {
      if (timedOut) throw new Error(`Tile request timed out: ${url}`);
      throw error;
    } finally {
      clearTimeout(timer);
      signal.removeEventListener('abort', cancel);
    }
  }

  async function load(tile, signal) {
    let local = localPath(tile);
    if (!local && options.detailCoverageReady) {
      // Known overview tiles can paint while detail coverage is still loading.
      try { await options.detailCoverageReady(); } catch {}
      if (signal.aborted) throw abortError();
      local = localPath(tile);
    }
    if (local) {
      try { return (await request(new URL(local, baseURL).href, signal)).data; }
      catch (error) { if (signal.aborted) throw error; }
    }
    const remote = remoteURL(tile);
    try {
      const cache = await persistentCache();
      const response = await cache?.match(remote);
      if (response?.ok && response.headers.get('content-type')?.startsWith('image/')) {
        const data = await response.arrayBuffer();
        if (signal.aborted) throw abortError();
        if (data.byteLength) return data;
      }
    } catch (error) { if (signal.aborted) throw error; }
    if (signal.aborted) throw abortError();
    const { data, contentType } = await request(remote, signal);
    persist(remote, data, contentType, signal);
    return data;
  }

  function handler(params, abortController) {
    let tile;
    try { tile = parseTile(params.url); }
    catch (error) { return Promise.reject(error); }
    const signal = abortController?.signal;
    if (signal?.aborted) return Promise.reject(abortError());
    if (memory.has(tile.key)) {
      const data = memory.get(tile.key);
      memory.delete(tile.key);
      memory.set(tile.key, data);
      return Promise.resolve({ data: data.slice(0) });
    }
    let entry = inFlight.get(tile.key);
    if (!entry) {
      entry = { controller: new AbortController(), consumers: 0, done: false };
      inFlight.set(tile.key, entry);
      entry.promise = load(tile, entry.controller.signal).then(data => {
        if (entry.controller.signal.aborted) throw abortError();
        remember(tile.key, data);
        return data;
      }).finally(() => {
        entry.done = true;
        if (inFlight.get(tile.key) === entry) inFlight.delete(tile.key);
      });
    }
    return new Promise((resolve, reject) => {
      entry.consumers++;
      let finished = false;
      function finish(error, data) {
        if (finished) return;
        finished = true;
        signal?.removeEventListener('abort', cancel);
        entry.consumers--;
        if (!entry.consumers && !entry.done) {
          if (inFlight.get(tile.key) === entry) inFlight.delete(tile.key);
          entry.controller.abort();
        }
        if (error) reject(error);
        else resolve({ data: data.slice(0) });
      }
      const cancel = () => finish(abortError());
      signal?.addEventListener('abort', cancel, { once: true });
      entry.promise.then(data => finish(null, data), error => finish(error));
    });
  }

  maplibregl.addProtocol('atlas', handler);
  return handler;
}
