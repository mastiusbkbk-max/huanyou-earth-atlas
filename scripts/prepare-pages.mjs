import { createReadStream } from 'node:fs';
import { copyFile, mkdir, readdir, readFile, realpath, rm, stat, writeFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { dirname, join, relative, resolve, sep } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const projectRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const totalLimit = 1_000_000_000;
const fileLimit = 100 * 1024 * 1024;
const within = (parent, child) => child === parent || child.startsWith(parent + sep);

async function canonicalPath(directory) {
  try { return await realpath(directory); }
  catch (error) {
    if (error.code !== 'ENOENT') throw error;
    return join(await canonicalPath(dirname(directory)), relative(dirname(directory), directory));
  }
}

async function guardOutput(directory, projectDirectory) {
  const root = await realpath(projectDirectory);
  const target = await canonicalPath(resolve(directory));
  if (within(target, root) || ['public', 'src', 'source', 'dist', '.git', 'scripts', 'tests', 'node_modules'].some(name => within(join(root, name), target))) {
    throw new Error(`Refusing to modify source or local production directory: ${target}`);
  }
  return target;
}

async function filesUnder(directory, prefix = '') {
  const files = [];
  for (const entry of await readdir(join(directory, prefix), { withFileTypes: true })) {
    const name = prefix + entry.name;
    if (entry.isSymbolicLink()) throw new Error(`Pages output cannot contain symlinks: ${name}`);
    if (entry.isDirectory()) files.push(...await filesUnder(directory, `${name}/`));
    else if (entry.isFile()) files.push(name);
  }
  return files.sort();
}

async function inventory(directory) {
  const files = [];
  let bytes = 0;
  for (const path of await filesUnder(directory)) {
    const info = await stat(join(directory, path));
    if (info.size >= fileLimit) throw new Error(`File must be smaller than 100 MiB: ${path} (${info.size} bytes)`);
    bytes += info.size;
    files.push({ path, bytes: info.size });
  }
  if (bytes >= totalLimit) throw new Error(`Pages output must be smaller than 1,000,000,000 bytes: ${bytes}`);
  return { files, bytes };
}

async function sha256(path) {
  const hash = createHash('sha256');
  for await (const chunk of createReadStream(path)) hash.update(chunk);
  return hash.digest('hex');
}

export async function prepareApp(directory, projectDirectory = projectRoot) {
  const output = await guardOutput(directory, projectDirectory);
  if (!(await stat(join(output, 'index.html'))).isFile() || !(await stat(join(output, 'assets'))).isDirectory()) {
    throw new Error('App output must contain a built index.html and assets directory');
  }
  // This command only trims the explicitly supplied, separate Pages build.
  await rm(join(output, 'models'), { recursive: true, force: true });
  await rm(join(output, 'tiles', 'terrain'), { recursive: true, force: true });
  await rm(join(output, 'static-delivery.json'), { force: true });
  for (const name of await filesUnder(output)) {
    if (/\.(br|gz)$/i.test(name)) await rm(join(output, name));
  }
  await writeFile(join(output, '.nojekyll'), '');
  const result = await inventory(output);
  return { mode: 'app', directory: output, files: result.files.length, bytes: result.bytes };
}

function modelDirectory(url) {
  const match = /^models\/([^/]+)\//.exec(url ?? '');
  if (!match || match[1] === '.' || match[1] === '..' || url.includes('\\') || url.split('/').includes('..')) {
    throw new Error(`Invalid local model path: ${url}`);
  }
  return match[1];
}

async function validateModelReferences(output, files) {
  for (const { path } of files) {
    if (!path.endsWith('.json') || path.endsWith('/source.json')) continue;
    const document = JSON.parse(await readFile(join(output, path), 'utf8'));
    const references = [];
    function visit(value) {
      if (!value || typeof value !== 'object') return;
      for (const [key, child] of Object.entries(value)) {
        if ((key === 'uri' || key === 'url') && typeof child === 'string') references.push(child);
        else visit(child);
      }
    }
    visit(document);
    for (const uri of references) {
      if (/^[a-z][a-z\d+.-]*:/i.test(uri)) continue;
      const target = fileURLToPath(new URL(uri, pathToFileURL(join(output, path))));
      if (!within(join(output, 'models'), target) || !(await stat(target).catch(() => null))?.isFile()) {
        throw new Error(`Missing or outside model dependency: ${path} -> ${uri}`);
      }
    }
  }
}

export async function prepareModels(directory, projectDirectory = projectRoot) {
  let output = await guardOutput(directory, projectDirectory);
  const existing = await readdir(output).catch(error => {
    if (error.code !== 'ENOENT') throw error;
    return [];
  });
  if (existing.length) throw new Error(`Refusing to overwrite nonempty output: ${output}`);
  const { worldScenes } = await import(pathToFileURL(join(projectDirectory, 'src/world-scenes.js')));
  const { realScenes } = await import(pathToFileURL(join(projectDirectory, 'src/real-scene.js')));
  const directories = new Set();
  for (const scene of [...worldScenes, ...realScenes]) {
    directories.add(modelDirectory(scene.pcUrl || scene.url));
    for (const tile of scene.terrainSource?.tiles ?? []) directories.add(modelDirectory(tile));
  }
  if (!directories.size) throw new Error('No current scene directories found');
  await mkdir(output, { recursive: true });
  output = await guardOutput(output, projectDirectory);
  const files = [];
  let modelBytes = 0;
  for (const name of [...directories].sort()) {
    const source = join(projectDirectory, 'public/models', name);
    for (const path of await filesUnder(source)) {
      const bytes = (await stat(join(source, path))).size;
      if (bytes >= fileLimit) throw new Error(`File must be smaller than 100 MiB: models/${name}/${path}`);
      modelBytes += bytes;
      if (modelBytes >= totalLimit) throw new Error(`Pages models must be smaller than 1,000,000,000 bytes: ${modelBytes}`);
      const destination = join(output, 'models', name, path);
      await mkdir(dirname(destination), { recursive: true });
      const hash = await sha256(join(source, path));
      await copyFile(join(source, path), destination);
      if (await sha256(destination) !== hash) throw new Error(`Copied model SHA-256 mismatch: models/${name}/${path}`);
      files.push({ path: `models/${name}/${path}`, bytes, sha256: hash });
    }
  }
  await validateModelReferences(output, files);
  await writeFile(join(output, 'asset-manifest.json'), JSON.stringify({ version: 1, modelBytes, directories: [...directories].sort(), files }, null, 2) + '\n');
  await writeFile(join(output, 'index.html'), '<!doctype html><html lang="zh-CN"><meta charset="utf-8"><title>寰游 · 实景模型</title><h1>寰游 · 高保真实景模型</h1><p>原始几何、层级和纹理完整保留。</p><a href="asset-manifest.json">文件大小与 SHA-256 清单</a></html>\n');
  await writeFile(join(output, '.nojekyll'), '');
  const result = await inventory(output);
  return { mode: 'models', directory: output, directories: directories.size, modelFiles: files.length, files: result.files.length, bytes: result.bytes, modelBytes };
}

if (process.argv[1] && pathToFileURL(resolve(process.argv[1])).href === import.meta.url) {
  const [mode, directory, ...extra] = process.argv.slice(2);
  if (!['--app', '--models'].includes(mode) || !directory || extra.length) {
    console.error('Usage: node scripts/prepare-pages.mjs --app OUTPUT | --models OUTPUT');
    process.exitCode = 1;
  } else {
    try { console.log(JSON.stringify(await (mode === '--app' ? prepareApp(directory) : prepareModels(directory)))); }
    catch (error) { console.error(error.message); process.exitCode = 1; }
  }
}
