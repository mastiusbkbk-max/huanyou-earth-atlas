import { defineConfig } from 'vite';
import { readdir, readFile, writeFile } from 'node:fs/promises';
import { resolve, join } from 'node:path';
import { prepareStaticDelivery, createStaticHandler } from './scripts/static-delivery.mjs';
let dataDirectory;
let outputDirectory;
let siteBase;
let productionBuild = false;

// base 与 GitHub Pages 子路径对应，使资源引用正确指向站点根
export default defineConfig({
  base: '/china-atlas/',
  plugins: [{
    name: 'compact-static-data',
    apply: 'build',
    configResolved(config) { dataDirectory = resolve(config.root, config.build.outDir, 'data'); },
    async writeBundle() {
      await Promise.all((await readdir(dataDirectory)).filter(name => /\.(geojson|json)$/.test(name)).map(async name => {
        const file = join(dataDirectory, name);
        await writeFile(file, JSON.stringify(JSON.parse(await readFile(file, 'utf8'))));
      }));
    }
  }, {
    name: 'compressed-static-delivery',
    configResolved(config) {
      outputDirectory = resolve(config.root, config.build.outDir);
      siteBase = config.base;
      productionBuild = config.command === 'build';
    },
    buildEnd(error) { if (error) productionBuild = false; },
    async closeBundle() {
      if (productionBuild && process.env.ATLAS_PAGES_BUILD !== '1') await prepareStaticDelivery(outputDirectory, siteBase);
    },
    async configurePreviewServer(server) {
      server.middlewares.use(await createStaticHandler({ directory: outputDirectory, base: siteBase }));
    },
  }],
});
