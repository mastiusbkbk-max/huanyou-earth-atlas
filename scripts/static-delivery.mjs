import { createReadStream } from 'node:fs';
import { readdir, readFile, writeFile, stat, realpath, unlink } from 'node:fs/promises';
import { resolve, relative, join, extname, sep } from 'node:path';
import { createHash } from 'node:crypto';
import { promisify } from 'node:util';
import { brotliCompress, gzip, constants } from 'node:zlib';

const brotli = promisify(brotliCompress);
const gzipFile = promisify(gzip);
const manifestName = 'static-delivery.json';
const compressible = /\.(?:html|js|mjs|css|json|geojson|wasm|b3dm|glb)$/i;
const types = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.mjs': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8', '.json': 'application/json', '.geojson': 'application/geo+json', '.wasm': 'application/wasm', '.b3dm': 'application/octet-stream', '.glb': 'model/gltf-binary', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.png': 'image/png', '.webp': 'image/webp', '.svg': 'image/svg+xml', '.woff2': 'font/woff2', '.txt': 'text/plain; charset=utf-8' };
const sha = data => createHash('sha256').update(data).digest('hex');

async function filesUnder(directory, prefix = '') {
  const files = [];
  for (const entry of await readdir(join(directory, prefix), { withFileTypes: true })) {
    const name = prefix + entry.name;
    if (entry.isDirectory()) files.push(...await filesUnder(directory, `${name}/`));
    else if (entry.isFile()) files.push(name);
  }
  return files;
}

// Runs after Vite's JSON compaction. Only useful representations are emitted;
// photographic JPEG/WebP, PNG and WOFF2 are already compressed and are skipped.
export async function prepareStaticDelivery(directory, base = '/') {
  const entries = {};
  const files = (await filesUnder(directory)).filter(name => name !== manifestName && compressible.test(name));
  const queue = [...files];
  async function worker() {
    while (queue.length) {
      const name = queue.shift();
      const path = join(directory, name);
      const original = await stat(path);
      if (original.size < 1024) continue;
      const data = await readFile(path);
      const entry = { bytes: data.length, mtimeMs: original.mtimeMs, sha256: sha(data) };
      for (const [encoding, suffix, compress] of [
        ['br', '.br', value => brotli(value, { params: { [constants.BROTLI_PARAM_QUALITY]: 5 } })],
        ['gzip', '.gz', value => gzipFile(value, { level: 6 })],
      ]) {
        const encoded = await compress(data);
        if (encoded.length < data.length * .95) {
          await writeFile(path + suffix, encoded);
          entry[encoding] = { bytes: encoded.length, sha256: sha(encoded) };
        } else await unlink(path + suffix).catch(error => { if (error.code !== 'ENOENT') throw error; });
      }
      entries[name] = entry;
    }
  }
  await Promise.all([worker(), worker()]);
  const manifest = { version: 1, base, entries: Object.fromEntries(Object.entries(entries).sort()) };
  await writeFile(join(directory, manifestName), JSON.stringify(manifest));
  return manifest;
}

function encodingFor(header = '', entry) {
  const weights = new Map(header.toLowerCase().split(',').map(part => {
    const [name, ...parameters] = part.trim().split(';');
    const quality = parameters.find(value => value.trim().startsWith('q='));
    const weight = quality ? Number(quality.trim().slice(2)) : 1;
    return [name, Number.isFinite(weight) && weight >= 0 && weight <= 1 ? weight : 0];
  }));
  return ['br', 'gzip'].filter(name => entry?.[name] && (weights.get(name) ?? weights.get('*') ?? 0) > 0)
    .sort((a, b) => (weights.get(b) ?? weights.get('*')) - (weights.get(a) ?? weights.get('*')))[0];
}

function safeRelativePath(rawPath, base) {
  try {
    if (/%2f|%5c/i.test(rawPath)) return null;
    const pathname = decodeURIComponent(rawPath);
    if (!pathname.startsWith(base) || /[\\\0]/.test(pathname)) return null;
    const path = pathname.slice(base.length);
    if (path.split('/').some(part => part === '.' || part === '..')) return null;
    return path.endsWith('/') || !path ? `${path}index.html` : path;
  } catch { return null; }
}

function byteRange(header, size) {
  const match = /^bytes=(\d*)-(\d*)$/.exec(header ?? '');
  if (!match || (!match[1] && !match[2])) return null;
  const start = match[1] ? Number(match[1]) : Math.max(0, size - Number(match[2]));
  const end = match[2] && match[1] ? Math.min(size - 1, Number(match[2])) : size - 1;
  return Number.isSafeInteger(start) && Number.isSafeInteger(end) && start <= end && start < size ? { start, end } : null;
}

export async function createStaticHandler({ directory, base } = {}) {
  const root = await realpath(resolve(directory));
  const manifest = await readFile(join(root, manifestName), 'utf8').then(JSON.parse).catch(() => ({ entries: {} }));
  const verified = new Map();
  base ??= manifest.base ?? '/';
  if (!base.startsWith('/') || !base.endsWith('/') || base.includes('..')) throw new Error('Invalid static base');
  async function currentEntry(file, info, entry) {
    if (!entry || entry.bytes !== info.size) return false;
    if (entry.mtimeMs === info.mtimeMs) return true;
    // Copying an artifact can change timestamps. Verify its source once, using
    // a stream and a bounded metadata table, instead of retaining file bodies.
    const key = `${file}:${info.mtimeMs}:${entry.sha256}`;
    if (!verified.has(key)) {
      verified.set(key, (async () => {
        const hash = createHash('sha256');
        for await (const chunk of createReadStream(file)) hash.update(chunk);
        return hash.digest('hex') === entry.sha256;
      })());
      while (verified.size > 128) verified.delete(verified.keys().next().value);
    }
    return verified.get(key);
  }
  function fail(res, status, text) {
    res.writeHead(status, { 'Content-Type': 'text/plain; charset=utf-8', 'Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff' });
    res.end(text);
  }
  return async (req, res) => {
    if (!['GET', 'HEAD'].includes(req.method)) { res.setHeader('Allow', 'GET, HEAD'); return fail(res, 405, 'Method not allowed'); }
    const rawPath = (req.url ?? '/').split('?')[0];
    if (base !== '/' && (rawPath === '/' || rawPath === base.slice(0, -1))) {
      res.writeHead(308, { Location: base, 'Cache-Control': 'no-cache' });
      return res.end();
    }
    const name = safeRelativePath(rawPath, base);
    if (name === null) return fail(res, 404, 'Not found');
    try {
      const file = await realpath(resolve(root, name));
      if (relative(root, file).startsWith(`..${sep}`) || relative(root, file) === '..' || !file.startsWith(root + sep)) return fail(res, 404, 'Not found');
      const original = await stat(file);
      if (!original.isFile()) return fail(res, 404, 'Not found');
      const entry = manifest.entries[name];
      const fresh = await currentEntry(file, original, entry);
      const encoding = req.headers.range ? undefined : encodingFor(req.headers['accept-encoding'], fresh && entry);
      let served = file;
      let size = original.size;
      let etag = fresh ? `"${entry.sha256}"` : `W/"${original.size}-${original.mtimeMs}"`;
      if (encoding) {
        const variant = await realpath(file + (encoding === 'br' ? '.br' : '.gz')).catch(() => null);
        const info = variant?.startsWith(root + sep) ? await stat(variant).catch(() => null) : null;
        if (info?.isFile() && info.size === entry[encoding].bytes) {
          served = variant;
          size = info.size;
          etag = `"${entry[encoding].sha256}"`;
          res.setHeader('Content-Encoding', encoding);
        }
      }
      const vary = String(res.getHeader?.('Vary') ?? '').split(',').map(value => value.trim()).filter(Boolean);
      res.setHeader('Vary', [...new Set([...vary, 'Accept-Encoding'])].join(', '));
      res.setHeader('Content-Type', types[extname(name).toLowerCase()] ?? 'application/octet-stream');
      res.setHeader('Cache-Control', /^assets\/.+-[\w-]{8,}\.[\w]+$/.test(name) ? 'public, max-age=31536000, immutable' : 'public, max-age=0, must-revalidate');
      res.setHeader('ETag', etag);
      res.setHeader('Last-Modified', original.mtime.toUTCString());
      res.setHeader('X-Content-Type-Options', 'nosniff');
      const requested = req.headers['if-none-match'];
      const sameTag = requested?.split(',').some(value => value.trim() === '*' || value.trim().replace(/^W\//, '') === etag.replace(/^W\//, ''));
      const sameDate = !requested && req.headers['if-modified-since'] && Date.parse(req.headers['if-modified-since']) >= Math.floor(original.mtimeMs / 1000) * 1000;
      if (sameTag || sameDate) { res.writeHead(304); return res.end(); }
      res.setHeader('Accept-Ranges', 'bytes');
      let range;
      if (req.headers.range && (!req.headers['if-range'] || req.headers['if-range'] === etag)) {
        range = byteRange(req.headers.range, size);
        if (!range) { res.setHeader('Content-Range', `bytes */${size}`); return fail(res, 416, 'Invalid range'); }
        res.setHeader('Content-Range', `bytes ${range.start}-${range.end}/${size}`);
      }
      res.setHeader('Content-Length', range ? range.end - range.start + 1 : size);
      res.writeHead(range ? 206 : 200);
      if (req.method === 'HEAD') return res.end();
      const stream = createReadStream(served, range);
      stream.on('error', () => res.destroy());
      res.on('close', () => stream.destroy());
      stream.pipe(res);
    } catch (error) {
      fail(res, error.code === 'ENOENT' || error.code === 'ENOTDIR' ? 404 : 500, 'File unavailable');
    }
  };
}
