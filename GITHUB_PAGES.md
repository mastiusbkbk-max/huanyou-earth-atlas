# 寰游 · 独立 GitHub Pages 发布

本次发布使用新仓库和新分支，旧站 `https://mastiusbkbk-max.github.io/china-atlas/` 与原仓库的 `main` / `gh-pages` 保持独立。

| 用途 | 新仓库 | 分支 | 公开地址 |
| --- | --- | --- | --- |
| 网站与完整源码 | [huanyou-earth-atlas](https://github.com/mastiusbkbk-max/huanyou-earth-atlas) | `codex/pc-performance-pages` | [打开寰游](https://mastiusbkbk-max.github.io/huanyou-earth-atlas/) |
| 高清实景资产 | [huanyou-earth-models](https://github.com/mastiusbkbk-max/huanyou-earth-models) | `codex/pc-scene-assets` | `https://mastiusbkbk-max.github.io/huanyou-earth-models/` |

## 容量与无损保留

GitHub Pages 单个已发布站点限 1 GB。原本地生产目录为 4,062,504,244 B，包含历史模型、当前 PC 模型与 Brotli/gzip 的重复交付文件。即使只保留当前 PC 运行文件，单站仍约 1.35 GB。

因此分为两个同域、不同路径的 Pages 站点：主站约 528 MB，模型约 825 MB。全部 199 地点、86 国家、30 条旅程、摄影、16 实景及里昂专用地形保留。当前模型的每级 LOD、几何、UV、摄影纹理均原样发布；无降采样、重编码或量化。最大单文件约 33.67 MB，低于 Git 的 100 MiB 单文件限制，无需 Git LFS。

模型站保留 17 个完整目录、2,567 文件；`asset-manifest.json` 记录逐文件大小和 SHA-256。主站只剔除重复的历史 PNG DEM（已有逐像素相同的 WebP）、模型目录和 Pages 无法协商的 `.br/.gz` 副本。主站卫星、WebP 高程、晕渲、照片、来源与许可元数据全部保留。

所有历史、PC、tablet / mobile 模型另在主仓库 Release `pc-models-2026-10-23` 完整无损归档；归档包含 `public/models/` 的全部 4,554 文件、原始 1,477,144,419 B。Release 同时保存归档 SHA-256 和逐文件清单，原本地目录不删除。当前运行模型与源代码都可从 GitHub 直接取得，历史派生模型可从 Release 恢复。

归档采用 Zstandard 长窗口无损压缩，文件名 `public-models.tar.zst`。恢复时下载 Release 中该文件及 `public-models.tar.zst.sha256`，在项目目录先校验，再执行 `tar --zstd -xf public-models.tar.zst`；需要本机安装 `zstd`。CI 的 Ubuntu 已包含解码器。普通本地开发命令不要求压缩工具，只有从归档恢复模型时才需要。

## 自动发布

模型站先发布并核对资源，随后主站由 `.github/workflows/pages.yml` 构建。主站推送 `codex/pc-performance-pages` 自动发布，也可在 Actions 手动执行。

工作流先下载、校验并恢复完整模型归档，然后运行单元检查、Vite 构建与 `scripts/prepare-pages.mjs --app dist-pages`。准备脚本核对实际部署总量小于 1,000,000,000 B、单文件小于 100 MiB；不会删除本地 `public/` 或普通 `dist/`。

主站构建参数：

```sh
ATLAS_PAGES_BUILD=1 VITE_MODEL_BASE_URL=https://mastiusbkbk-max.github.io/huanyou-earth-models/ npm run build -- --base /huanyou-earth-atlas/ --outDir dist-pages
node scripts/prepare-pages.mjs --app dist-pages
```

`VITE_MODEL_BASE_URL` 只改写 `models/` 资源根地址，保留后面的完整路径。模型自己的外部子树与 B3DM 相对地址不变；里昂地形也走该资源根。地图瓦片和摄影继续使用主站路径。未设置该变量时，现有本地开发和 `npm run serve` 的加载方式保持不变。

两个 Pages 站点均为 `mastiusbkbk-max.github.io`，资源同源，不需要额外 CORS 服务或浏览器解压。GitHub Pages 决定线上 HTTP 缓存与压缩策略，本地生产服务器的 Brotli 与毫秒级性能数据不能直接等同于公网表现。
