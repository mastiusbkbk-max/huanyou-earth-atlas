# 墨尔本高保真摄影地标数据

新增三个真实航拍摄影网格片区：弗林德斯街车站、皇家展览馆、战争纪念馆。数据来自墨尔本市政府 2018 年摄影测量开放档案，采用原生最高 L20 几何。模型已转换并保存在项目内，运行时无需第三方模型账号或临时下载链接。

## 2026-10-23 · 当前 PC 原档版本

PC 已切换到独立 `-pc` 目录，保留全部原三角面、面顺序、位置与 UV，通过标准 glTF 索引合并字节完全相同的重复顶点，并恢复原始档案中的完整 JPEG 字节，不进行摄影重采样或重新压缩。三处合计八幅原图，其中六幅原生 8K、两幅原生 4K；下文 4096px 版本作为此前处理记录与可追溯原文件保留。

| PC 片区 | 模型字节 | 原始摄影尺寸 | 纯 RGBA 底量 |
| --- | ---: | --- | ---: |
| 弗林德斯街车站 | 67,820,524 B | 8192² × 2、8192 × 4096 | 640 MiB |
| 皇家展览馆 | 71,974,032 B | 8192² × 2、4096²、4096 × 2048 | 608 MiB |
| 战争纪念馆 | 30,514,008 B | 8192² | 256 MiB |

RGBA 仅为纹理像素底量，不含几何、地图、图像解码暂存与浏览器资源，也不是进程显存的实测峰值。索引化不能消除原始 8K 摄影的解码和上传成本。派生步骤见 `scripts/optimize-scene-models.py`，各 `-pc/source.json` 记录原模型哈希、按原三角面展开的属性哈希与最终原图哈希。

## 此前 4096px 处理记录

| 片区 | 入口 | 原始分块 | 三角数 | B3DM 文件 | 文件总量 | 纹理尺寸 | 纯 RGBA 解码量 |
| --- | --- | --- | ---: | ---: | ---: | --- | ---: |
| 弗林德斯街车站 | `#world-melbourne-flinders-3d` | `Tile_+015_+010`、`Tile_+016_+010` | 830,055 | 3 | 71,030,864 B | 4096² × 2、4096 × 2048 | 160 MiB |
| 皇家展览馆 | `#world-melbourne-exhibition-3d` | `Tile_+016_+013`、`Tile_+017_+013` | 967,877 | 4 | 84,119,372 B | 4096² × 3、4096 × 2048 | 224 MiB |
| 战争纪念馆 | `#world-melbourne-shrine-3d` | `Tile_+017_+008` | 407,125 | 1 | 33,666,864 B | 4096² | 64 MiB |

合计 2,205,057 个三角形、188,817,100 B 模型文件。车站和展览馆各覆盖相邻两个约 500 × 500 米分块，补齐跨分块的主体建筑；纪念馆覆盖一个完整分块。片区外继续显示卫星影像。

RGBA 数值逐张计入所有摄影材质，表示一个场景完整加载时的纹理像素内存，不是浏览器进程峰值。三个场景另分别约有 47.50、55.38、23.30 MiB 的位置与 UV 属性；图片解码临时内存、GPU 对象和地图本身还会占用内存。PC 与 iPad 使用同一模型，本次没有制作手机版本。

## 来源与许可证据

- [墨尔本市政府官方数据集](https://data.melbourne.vic.gov.au/explore/dataset/city-of-melbourne-3d-textured-mesh-photomesh-2018/)明确写明：May 2018、7.5 cm ground sample distance、OBJ/MTL/JPEG 摄影网格、原生层级 L13–L20。
- [官方目录 API](https://data.melbourne.vic.gov.au/api/explore/v2.1/catalog/datasets/city-of-melbourne-3d-textured-mesh-photomesh-2018)的 `metas.default.license` 为 `CC BY`，`license_url` 指向 [CC BY 4.0 正文](https://creativecommons.org/licenses/by/4.0/legalcode)。目录快照保存在 `artifacts/landmark-scenes/melbourne-catalogue-2018.json`。
- 官方目录链接的档案为 `https://opendatasoft-s3.s3.ap-southeast-2.amazonaws.com/attachments/3DTexturedMesh/CoM_3D_Mesh_2018_OBJ.zip`，共 10,409,324,058 B。该区域端点在本次环境发生 TLS 超时，因此使用同一 S3 桶、同一对象的[全球端点](https://opendatasoft-s3.s3.amazonaws.com/attachments/3DTexturedMesh/CoM_3D_Mesh_2018_OBJ.zip)，HTTP Range 206 已实测。每个成员还校验原 ZIP CRC32。
- [官方瓦片 KML 索引](https://data.melbourne.vic.gov.au/api/explore/v2.1/catalog/datasets/city-of-melbourne-3d-textured-mesh-photomesh-2018/attachments/tile_index_kml)用于核对分块的真实位置，快照保存在 `artifacts/landmark-scenes/tile-index.kml`。
- 显示署名统一为 `© City of Melbourne · Photomesh 2018 · CC BY 4.0`，模型的 `source.json`、应用场景配置均附来源页与许可链接。2018 是官方采集年份，不能用档案服务器的修改日期代替。

此前也核对了官方 2020 摄影网格。其单个约 280 米分块包含约 581 MB OBJ 和数千张图片；本次采用结构清晰、可逐分块核验的 2018 L20 数据。Smithsonian 页面本次返回 403，没有将其作为已接入数据。

## 坐标、尺度和转换

归档中的 `metadata.xml` 明确声明 `EPSG:28355+5773`，原点为 `319000,5813000,0`。水平坐标是 GDA94 / MGA zone 55，单位为米；`EPSG:5773` 对应 EGM96 正高。网页目录同时将垂直基准描述为 AHD，两者存在冲突。本次跟随实际下载档案的显式 CRS，保留冲突说明，不宣称测绘级垂直精度。

转换过程：

1. 给原始 OBJ 的平面坐标加回官方原点，用 EPSG:28355 反投影得到经纬度。
2. 用 PROJ 官方 `us_nga_egm96_15.tif` 将档案声明的正高转换为 WGS84 椭球高，转为 ECEF。
3. 将 ECEF 几何存为场景中心附近的局部 ENU float32，根节点保留 double 精度的 ECEF 变换。glTF 使用标准 Y-up，OBJ UV 的 V 轴按格式约定翻转。
4. 应用现有 `datumOffset` 沿当地 geodetic up 校正渲染高度，与已有赫尔辛基场景的策略一致。模型包含真实摄影地面，场景未开启通用 DSM，避免把城市地表起伏再次叠加到建筑上。

所有原始 L20 三角面、面顺序与材质映射均保留，没有几何减面或建筑拉伸。原照片超过 4096 像素时使用 Lanczos 缩至 4096 上限，JPEG quality 94、4:4:4；已在该上限以内的照片保持原始字节。`source.json` 同时记录原图和发布照片的尺寸、SHA256、字节数，供核对照片优化。未生成或替换摄影内容。

## 文件与复现

模型目录为 `public/models/world-melbourne-flinders/`、`public/models/world-melbourne-exhibition/`、`public/models/world-melbourne-shrine/`。每个目录包含标准 `tileset.json`、B3DM 和完整 `source.json`。来源清单包括下载位置、采集年份、许可、坐标原点、高程范围、真实地理范围、各原始成员 CRC/SHA、输出哈希与纹理内存。

```sh
python3 -m pip install numpy requests Pillow pyproj
python3 scripts/prepare-landmark-scenes.py
python3 scripts/prepare-landmark-scenes.py --audit
node --test tests/landmark-scene-data.test.mjs
LANDMARK_SCENE_AUDIT_ORIGINALS=1 node --test tests/landmark-scene-data.test.mjs
```

提取器只用 HTTP Range 读取选中地标的原始 ZIP 成员，不下载完整十余 GB 城市档案。原始成员存入忽略的 `artifacts/landmark-scenes/originals/`，已有成员直接复用。`scene-configurations.json` 提供注册配置，正式注册位于 `src/world-scenes.js`。

默认测试仅依赖项目已发布文件，核验来源字段、完整地标覆盖、B3DM/纹理哈希、全部材质的真实尺寸及预算。可选原始审计额外校验所有源成员哈希、所有原始三角面数量及每一个面角的 UV。`--audit` 则从已发布的局部坐标反算 ECEF 和原始 MGA/正高，逐角比较真实源坐标，容差为 1 mm；结果保存在 `artifacts/landmark-scenes/geometry-audit.json`。

本次原始审计 7/7 通过，逐一核对 2,205,057 个三角面、6,615,171 个面角；全部 UV 与源映射一致。反投影最大数值误差为 0.000030792 米（约 0.031 mm）。这衡量的是格式转换误差，不代表来源数据的测绘定位精度。
