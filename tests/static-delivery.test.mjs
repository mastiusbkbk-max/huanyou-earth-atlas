import test, { before, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, readFile, writeFile, rm, access, symlink, utimes } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { PassThrough } from 'node:stream';
import { brotliDecompressSync, gunzipSync } from 'node:zlib';
import { prepareStaticDelivery, createStaticHandler } from '../scripts/static-delivery.mjs';

let root, handler, manifest;
const code = Buffer.from('const retainedQuality = "no geometry or photograph changes";\n'.repeat(400));
const mesh = Buffer.concat([Buffer.from('b3dm'), Buffer.from('geometry-and-original-photography\0'.repeat(2000))]);
const files = { 'index.html': Buffer.from('<html><title>寰游</title></html>'.repeat(80)), 'assets/app-Abcd1234.js': code, 'models/a/mesh.b3dm': mesh, 'data/mutable.json': Buffer.from(JSON.stringify({ values: Array(1000).fill('first') })), 'data/same-size.json': Buffer.from(JSON.stringify({ values: Array(1000).fill('original') })), 'images/photo.jpg': Buffer.alloc(5000, 1) };

before(async () => {
  root = await mkdtemp(join(tmpdir(), 'atlas-delivery-'));
  for (const [name, bytes] of Object.entries(files)) {
    await mkdir(join(root, name, '..'), { recursive: true });
    await writeFile(join(root, name), bytes);
  }
  manifest = await prepareStaticDelivery(root, '/china-atlas/');
  handler = await createStaticHandler({ directory: root });
});
after(async () => { await rm(root, { recursive: true, force: true }); });

async function request(url, headers = {}, method = 'GET', serve = handler) {
  const response = new PassThrough();
  const received = [];
  response.headers = {};
  response.statusCode = 200;
  response.setHeader = (name, value) => { response.headers[name.toLowerCase()] = String(value); };
  response.getHeader = name => response.headers[name.toLowerCase()];
  response.writeHead = (status, values = {}) => {
    response.statusCode = status;
    for (const [name, value] of Object.entries(values)) response.setHeader(name, value);
  };
  response.on('data', value => received.push(value));
  const complete = new Promise((resolve, reject) => { response.on('end', resolve); response.on('error', reject); });
  await serve({ url, headers, method }, response);
  await complete;
  return { status: response.statusCode, headers: response.headers, body: Buffer.concat(received) };
}

test('build representations decompress to exact source bytes and skip already compressed photography', async () => {
  for (const name of ['assets/app-Abcd1234.js', 'models/a/mesh.b3dm']) {
    assert.deepEqual(await readFile(join(root, name)), files[name]);
    assert.deepEqual(brotliDecompressSync(await readFile(join(root, `${name}.br`))), files[name]);
    assert.deepEqual(gunzipSync(await readFile(join(root, `${name}.gz`))), files[name]);
    assert.ok(manifest.entries[name].br.bytes < files[name].length);
  }
  assert.equal(manifest.entries['images/photo.jpg'], undefined);
  await assert.rejects(access(join(root, 'images/photo.jpg.br')));
});

test('serves Brotli or gzip according to negotiation with representation-specific validators', async () => {
  const path = '/china-atlas/assets/app-Abcd1234.js';
  const br = await request(path, { 'accept-encoding': 'gzip, br' });
  assert.equal(br.headers['content-encoding'], 'br');
  assert.deepEqual(brotliDecompressSync(br.body), code);
  assert.equal(Number(br.headers['content-length']), br.body.length);
  assert.equal(br.headers.vary, 'Accept-Encoding');
  assert.match(br.headers['content-type'], /javascript/);
  const gzip = await request(path, { 'accept-encoding': 'br;q=0, gzip;q=1' });
  assert.equal(gzip.headers['content-encoding'], 'gzip');
  assert.deepEqual(gunzipSync(gzip.body), code);
  const plain = await request(path, { 'accept-encoding': 'gzip;q=0, br;q=0' });
  assert.equal(plain.headers['content-encoding'], undefined);
  assert.deepEqual(plain.body, code);
  assert.notEqual(br.headers.etag, plain.headers.etag);
});

test('hashed code is immutable while models validate updates and warm requests transfer no body', async () => {
  const codeResponse = await request('/china-atlas/assets/app-Abcd1234.js');
  assert.equal(codeResponse.headers['cache-control'], 'public, max-age=31536000, immutable');
  const path = '/china-atlas/models/a/mesh.b3dm';
  const cold = await request(path, { 'accept-encoding': 'br' });
  assert.equal(cold.headers['cache-control'], 'public, max-age=0, must-revalidate');
  const warm = await request(path, { 'accept-encoding': 'br', 'if-none-match': cold.headers.etag });
  assert.equal(warm.status, 304);
  assert.equal(warm.body.length, 0);
  const revalidated = await request(path, { 'if-modified-since': cold.headers['last-modified'] });
  assert.equal(revalidated.status, 304);
});

test('changed unversioned files bypass stale compressed representations and return new validators', async () => {
  const path = '/china-atlas/data/mutable.json';
  const old = await request(path, { 'accept-encoding': 'br' });
  const updated = Buffer.from(JSON.stringify({ values: Array(1500).fill('updated') }));
  await writeFile(join(root, 'data/mutable.json'), updated);
  const current = await request(path, { 'accept-encoding': 'br', 'if-none-match': old.headers.etag });
  assert.equal(current.status, 200);
  assert.equal(current.headers['content-encoding'], undefined);
  assert.notEqual(current.headers.etag, old.headers.etag);
  assert.deepEqual(current.body, updated);
});

test('copied artifacts keep compression after timestamps change, while same-sized edits cannot use old compressed bytes', async () => {
  const file = join(root, 'models/a/mesh.b3dm');
  const later = new Date(Date.now() + 20000);
  await utimes(file, later, later);
  const copied = await request('/china-atlas/models/a/mesh.b3dm', { 'accept-encoding': 'br' });
  assert.equal(copied.headers['content-encoding'], 'br');
  assert.deepEqual(brotliDecompressSync(copied.body), mesh);
  const path = join(root, 'data/same-size.json');
  const old = await readFile(path);
  const changed = Buffer.from(old.toString().replace('original', 'modified'));
  assert.equal(changed.length, old.length);
  await writeFile(path, changed);
  const response = await request('/china-atlas/data/same-size.json', { 'accept-encoding': 'br' });
  assert.equal(response.headers['content-encoding'], undefined);
  assert.deepEqual(response.body, changed);
});

test('rejects traversal, symlink escape, missing model and methods without caching an HTML fallback', async () => {
  await symlink(join(root, '..'), join(root, 'escape'));
  for (const path of ['/china-atlas/../package.json', '/china-atlas/%2e%2e/package.json', '/china-atlas/models%2fa/mesh.b3dm', '/china-atlas/%00', '/china-atlas/%zz', '/outside/index.html', '/china-atlas/escape/', '/china-atlas/models/missing.b3dm']) {
    const result = await request(path);
    assert.equal(result.status, 404, path);
    assert.equal(result.headers['cache-control'], 'no-store');
    assert.doesNotMatch(result.headers['content-type'], /html/);
  }
  const post = await request('/china-atlas/index.html', {}, 'POST');
  assert.equal(post.status, 405);
  assert.equal(post.headers.allow, 'GET, HEAD');
});

test('HEAD, partial requests and validator-mismatched ranges preserve HTTP semantics', async () => {
  const path = '/china-atlas/models/a/mesh.b3dm';
  const head = await request(path, { 'accept-encoding': 'br' }, 'HEAD');
  assert.equal(head.body.length, 0);
  assert.equal(head.headers['content-encoding'], 'br');
  assert.equal(Number(head.headers['content-length']), manifest.entries['models/a/mesh.b3dm'].br.bytes);
  const range = await request(path, { range: 'bytes=4-19', 'accept-encoding': 'br' });
  assert.equal(range.status, 206);
  assert.equal(range.headers['content-encoding'], undefined);
  assert.deepEqual(range.body, mesh.subarray(4, 20));
  assert.equal(range.headers['content-range'], `bytes 4-19/${mesh.length}`);
  const suffix = await request(path, { range: 'bytes=-8' });
  assert.deepEqual(suffix.body, mesh.subarray(-8));
  const full = await request(path, { range: 'bytes=4-19', 'if-range': '"old-model"' });
  assert.equal(full.status, 200);
  assert.deepEqual(full.body, mesh);
  const invalid = await request(path, { range: 'bytes=99999999-' });
  assert.equal(invalid.status, 416);
  assert.equal(invalid.headers['cache-control'], 'no-store');
});

test('deployment base redirects only the root and supports an explicit root deployment', async () => {
  const redirect = await request('/');
  assert.equal(redirect.status, 308);
  assert.equal(redirect.headers.location, '/china-atlas/');
  const rootHandler = await createStaticHandler({ directory: root, base: '/' });
  const index = await request('/', {}, 'GET', rootHandler);
  assert.equal(index.status, 200);
  assert.deepEqual(index.body, files['index.html']);
});
