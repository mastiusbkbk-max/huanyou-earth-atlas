# 海外三维片区：来源、精度与复现

已部署的海外片区仅收录已下载、验证并具有公开复用许可的数据。它们不代表整座城市已覆盖，也不代表实时影像。配置入口是 `src/world-scenes.js`；每个模型目录的 `source.json` 保存更详细的原始文件、SHA-256、字节数与转换依据。

## 2026-10-23 · PC 无损索引版本

当前 PC 通过 `pcUrl` 使用十处海外片区的独立 `-pc` 派生目录。`scripts/optimize-scene-models.py` 只合并 POSITION 与 UV 字节完全相同的重复顶点，使用标准 glTF 索引；按索引展开后，全部原三角面的顺序、位置与 UV 逐字节一致。坐标变换、tileset、覆盖范围与原始模型目录均保留，不需要增加解码器。赫尔辛基六区的 B3DM 总量减少约 42%–45%，原 JPEG 字节不变。

墨尔本三个 PC 片区另恢复原档 JPEG：六张原生 8K、两张原生 4K，不重采样或重新压缩。其索引化后的模型量与纹理规模见 [LANDMARK_SCENE_DATA.md](LANDMARK_SCENE_DATA.md)。原先的平板和手机派生文件保留，但当前 PC 入口不根据视口宽度切换到这些版本；下文适配说明为此前处理记录。

## 芬兰 · 赫尔辛基（已部署）

来源为 **City of Helsinki / Helsinki 3D 2017 摄影测量三角网格**，许可 **CC BY 4.0**。官方说明明确该模型由航拍照片计算几何与纹理，可用于网络服务，并提供公开下载。

- 官方说明：https://www.hel.fi/en/decision-making/information-on-helsinki/maps-and-geospatial-data/helsinki-3d
- 数据目录：https://hri.fi/data/en_GB/dataset/helsingin-3d-kaupunkimalli
- 官方原档：https://3d.hel.ninja/data/mesh/Helsinki3D-MESH_2017_OBJ_2km-250m_ZIP/Helsinki3D_2017_OBJ_672496x2.zip
- 岩石教堂原档：https://3d.hel.ninja/data/mesh/Helsinki3D-MESH_2017_OBJ_2km-250m_ZIP/Helsinki3D_2017_OBJ_672494x2.zip
- 芬兰堡原档：https://3d.hel.ninja/data/mesh/Helsinki3D-MESH_2017_OBJ_2km-250m_ZIP/Helsinki3D_2017_OBJ_670498x2.zip
- 许可：https://creativecommons.org/licenses/by/4.0/
- 署名：© City of Helsinki · Helsinki 3D 2017 · CC BY 4.0

| 片区 | 实际范围约 | 原分块 | 子网格 | 三角形 | 部署模型字节 |
| --- | --- | --- | ---: | ---: | ---: |
| 大教堂与议会广场 | 250 × 500 米 | 673497a3、672497b4 | 132 | 386,999 | 33,886,904 |
| 中央车站与铁路广场 | 500 × 500 米 | 673496c1–c4 | 261 | 709,915 | 61,967,836 |
| 乌斯别斯基大教堂 | 250 × 250 米 | 672497d4 | 65 | 182,861 | 15,896,776 |
| 集市广场、总统府与南港岸线 | 500 × 500 米 | 672497b3、b4、d1、d2 | 257 | 524,768 | 48,635,572 |
| 坦佩利奥基奥岩石教堂 | 250 × 250 米 | 673495c4 | 64 | 211,709 | 18,650,472 |
| 芬兰堡大庭院与周边堡垒 | 500 × 500 米 | 670499a1–a4 | 256 | 713,667 | 63,925,940 |

本轮四处新增摄影网格合计 **147,108,760 字节、642 个子网格、1,633,005 个原始三角形**。芬兰堡只覆盖大庭院、埃伦斯瓦德墓及其周边区域，范围不包含芬兰堡教堂、国王之门或整个海上要塞。芬兰地亚大厦未纳入：当前选块的西界靠近建筑，完整范围仍需进一步核查及扩块，避免交付截断地标。

这里选取原档 **L20 层级**，并非完整原档所有最高层级。保留这一层级的原三角形拓扑和原 JPEG 字节，未进行几何简化、楼宇拉伸、照片重压缩或生成填补。OBJ UV 的纵向只按 glTF 约定翻转，照片内容不变。输出为标准 Y-up glTF，封装于 B3DM 和 3D Tiles 1.0。

实际原档 `metadata.xml` 指定 **EPSG:3879+5773**，原点 `[25490000, 6668000, 0]`。转换采用 EPSG:3879 的逆投影，以及公开 PROJ `us_nga_egm96_15.tif` 网格，将文件明确声明的 EGM96 正高转为椭球高，再转 WGS84 ECEF。官网总说明也使用 N2000 术语；本站以**当前原档实际声明**为转换依据，并在每份清单保留这一差异，避免默默混用高程基准。

ECEF 大原点保留于 JSON 的双精度变换矩阵，顶点写为附近 ENU 局部坐标。Float32 写入误差小于 0.1 毫米，这是数值存储误差，**不是原航测测量精度承诺**。摄影测量、源影像、基准与大地水准面模型各有自身误差。2017 指原数据版本/航拍年份，服务器显示的 2025 修改日期不是新航拍日期。

空的 3D Tiles 根节点采用 `geometricError:600`，使当前 loaders.gl 遍历到最终网格；各最终网格仍为 0。范围外仍显示卫星底图。

复现：

```sh
python3 -m pip install numpy requests Pillow pyproj
python3 scripts/prepare-world-scenes.py
node --test tests/world-scene-data.test.mjs
# 可选原档审计：先运行准备脚本取得被 Git 排除的 artifacts，再逐面比较
WORLD_SCENE_AUDIT_ORIGINALS=1 node --test tests/world-scene-data.test.mjs
```

准备脚本使用 HTTP Range 从约 1.94 GB 的原档提取所需分块，不下载整城。原 OBJ、MTL、JPEG、原档元数据及 EGM96 网格留在 `artifacts/world-scenes/`，便于复核；网站只需 `public/models/world-*` 中的产物。

新增四处使用三个官方原档，已分别提取并确认相同的 `EPSG:3879+5773` 与源原点。原档目录和元数据证据保存在 `artifacts/world-scenes/helsinki-archive-*-catalogue.json` 与 `helsinki-archive-*-metadata.xml`。仅生成这四处新增片区可执行以下命令，既有模型不重建：

```sh
python3 -c 'import runpy; runpy.run_path("scripts/prepare-world-scenes.py")["helsinki_expansions"]()'
```

新增片区的原 OBJ 逐面三角形、UV 与原 JPEG 字节均由显式原档审计核对。当前目标是 PC 与 iPad；PC 使用原始 L20 纹理，iPad 大片区另有下述摄影纹理适配，尚未进行手机专项验收。

### 赫尔辛基 iPad 摄影纹理适配

JPEG 下载字节不能代表解码后的纹理规模。逐张读取原 JPEG 帧头后，四处大片区的原纹理均超过 250 MiB RGBA。为保持相同地理覆盖和全部原几何，为它们建立独立 `-tablet` 目录，并通过 `tabletUrl` 选择；桌面原模型与原 JPEG 字节不变。

| 片区 | PC 原 JPEG 解码 RGBA | iPad 解码 RGBA | iPad 模型字节 |
| --- | ---: | ---: | ---: |
| 大教堂 | 438.001 MiB | 112.501 MiB | 31,937,500 |
| 中央车站 | 799 MiB | 214 MiB | 58,348,056 |
| 集市广场 | 682.001 MiB | 203.501 MiB | 45,703,348 |
| 芬兰堡大庭院 | 797 MiB | 206 MiB | 59,882,076 |

只有最长边超过 512 像素的照片按比例缩小：Pillow LANCZOS、JPEG quality 95、4:4:4。原本较小的照片保留原 JPEG 字节。每张新照片的原哈希、原尺寸、输出尺寸与新哈希都记录在 `source.json`。这属于**iPad 摄影纹理适配**，不能声称原照片逐字节保留；照片近看细节少于 PC 版本。原三角形、POSITION 与 UV 数据、源分块、坐标变换、绝对高程、tileset 和覆盖范围逐字节或逐项一致，由专项测试核对。

乌斯别斯基与岩石教堂的原照片分别为 220 MiB、232 MiB RGBA，直接复用原版。上表仅表示纹理按 RGBA 解码的理论规模，不是页面总显存；网格、地图、浏览器及暂存图像还需其他资源。模型采样器使用 LINEAR，没有请求 mipmap。PC/iPad 的实际渲染、切换及稳定性由浏览器验收另行确认。

仅重建四处 iPad 版本：

```sh
python3 -c 'import runpy; runpy.run_path("scripts/prepare-world-scenes.py")["helsinki_tablet"]()'
```

普通测试仅依赖随站点部署的模型及 `source.json`：核对模型 SHA/字节数、清单三角形数量、UV 数量与有限值、每张内嵌 JPEG 的原字节 SHA，以及实际解码顶点经过双精度变换后的地理范围和高程。干净检出无需原档即可运行。带 `WORLD_SCENE_AUDIT_ORIGINALS=1` 的显式审计另外读取原 OBJ、JPEG 与大地水准面网格，逐面核对 UV、三角形数量及原照片字节；该原档审计已在本机完成。浏览器内的实际 GPU、相机与视觉验收另由主任务执行。

## 法国 · 里昂市政厅与歌剧院（已部署）

官方 **Métropole de Lyon 2018 CityGML 纹理建筑模型** 的元数据明确 **Licence Ouverte 2.0**，允许公开复用；这类是 **LoD2 几何加真实立面/屋面摄影纹理的城市建筑数字模型**，不能称为赫尔辛基那样的连续摄影测量网格。

- 官方数据页：https://data.grandlyon.com/portail/fr/jeux-de-donnees/maquettes-3d-texturees-2018-communes-metropole-lyon/info
- 官方许可：https://www.etalab.gouv.fr/wp-content/uploads/2017/04/ETALAB-Licence-Ouverte-v2.0.pdf
- 第一城区原档：https://download.data.grandlyon.com/files/grandlyon/imagerie/2018/maquette/LYON_1ER_2018.zip
- VCity / LIRIS 原转换团队说明：https://github.com/VCityTeam/UD-Demo-vcity-py3dtilers-lyon/blob/master/doc/textured.md
- LIRIS 数据集明确许可声明：https://dataset-dl.liris.cnrs.fr/three-d-tiles-lyon-metropolis/README.txt
- 同目录开放许可全文：https://dataset-dl.liris.cnrs.fr/three-d-tiles-lyon-metropolis/ETALAB-Licence-Ouverte-v2.0_EN.pdf
- 已核实可下载的源索引：https://dataset-dl.liris.cnrs.fr/three-d-tiles-lyon-metropolis/2018/Lyon-1_2018_Textured/tileset.json
- 署名：© Métropole de Lyon 2018 · VCity / LIRIS · Licence Ouverte 2.0

本地模型覆盖约 **270 × 200 米**，包含市政厅（原 GML ID **69381AS18**）、歌剧院（**69381AS19**）及相邻建筑，共 **54 个原建筑 ID、4 个源分组、8,091 个三角形、18,732,708 字节**。采用原数据集各分组的最高纹理叶层级 `389 / 444 / 449 / 464.b3dm`；图集 JPEG 总计约 18.24 MB，逐字节保留，不重新采样或压缩。2018 是官方数据版本；元数据具体说明摄影纹理取自 **2018 年 4–7 月** 的垂直和倾斜摄影，不是实时影像。

LIRIS 根目录 README **明确对整个数据集采用 ETALAB v2.0 开放许可**。下载这些小范围原转换文件，不依赖整城区数 GB 原档；许可依据也不来自 iTowns 示例仓库。原转换分组的 CC46 XYZ 局部坐标、源节点平移与 glTF 轴约定已逐项核对。本站将其重新投影为 WGS84 ECEF + ENU 局部 Float32，保留原三角形顺序、原 glTF UV 及照片原字节，无几何简化或生成建筑。显式原档审计已核对所有 UV、三角形数量、JPEG 与原模型 SHA。

另外从官方 CityGML 原档独立提取了市政厅，核对源 ID 和建筑边界：LIRIS 市政厅的 3,324 个三角形顶点与官方 CityGML 最近原顶点最大坐标差约 **0.251 米**，这是**上游 LIRIS 源模型已有的数值量化/转换差异**，并非当前 ENU 转码造成，也不是测量误差声明。当前再转码的 Float32 数值误差小于 0.1 毫米。复核记录留在 `artifacts/world-scenes/lyon-official-gml-audit.json`。

**垂直基准的明确限制：**2018 CityGML 只声明水平 **EPSG:3946**，没有直接写出垂直 EPSG。Métropole de Lyon 官方地形测量数据明确采用 **RGF93-CC46 / NGF-IGN69**，因此当前转换将 NGF-IGN69 作为这一地方模型的高程基准假设，使用公开 IGN / PROJ `fr_ign_RAF18.tif` 将正高转为椭球高。该假设已逐字保留于 `source.json`，不承诺绝对测量精度。本站开启真实 1 倍地形底图承接建筑原绝对高程，不对模型任意减数贴地。参考官方地形测量数据：https://data.grandlyon.com/portail/fr/jeux-de-donnees/plans-topographiques-metropole-lyon/info

产品将此片区标为**建筑数字模型**，与赫尔辛基的连续摄影测量实景区别呈现。建筑外的街道、广场和周边区域来自卫星底图；该片区也不能代表里昂全城覆盖。

### 里昂手机纹理版本

`world-lyon-cityhall-mobile` 使用**同一 LIRIS 数据集的原生上一层纹理**，对应 `388 / 443 / 448 / 463.b3dm`，不是自行缩图。图集原 JPEG 字节、原 UV 均保留。桌面仍使用上文原最高纹理版本。

| 项目 | 桌面最高原生纹理 | 手机原生纹理 |
| --- | ---: | ---: |
| 模型下载字节 | 18,732,708 | 3,185,124 |
| 4 张图集尺寸 | 2 × 4609² + 2 × 6145² | 2 × 1536² + 2 × 2048² |
| 解码 RGBA 理论内存 | 450.16 MiB | **50 MiB** |
| 原三角形数 | 8,091 | 8,091 |
| 原建筑 ID 数 | 54 | 54 |

下载模型减少约 **83%**，纹理解码 RGBA 减少约 **89%**。这只是图集的理论内存，不是浏览器整个页面的实际常驻显存；即使完整生成 mipmap，手机图集也约 66.7 MiB。专项测试直接读取 JPEG 帧头验证实际尺寸与 ≤96 MiB 预算，并逐字节对比两个版本的全部 POSITION 数据：建筑几何、原点变换、边界、绝对高程和覆盖范围完全一致。手机原生图集保留了该层级的原照片内容，近距离纹理细节少于桌面最高层级。

配置 `mobileUrl` 指向手机版本，渲染入口据设备选择。准备脚本默认生成两个版本；仅重建手机版本可运行：

```sh
python3 -c 'import runpy; runpy.run_path("scripts/prepare-world-scenes.py")["lyon"](mobile=True)'
```

里昂的 `tabletUrl` 复用这份约 50 MiB RGBA 的**原生上一层摄影纹理**数据，不另行复制文件；其几何仍与 PC 一致。产品对 iPad 使用这一原生纹理层级，并保留现有手机配置。

### 里昂同版官方地面 TIN

通用 Mapzen DEM 在这里含有明显的城市表面高估：对 54 栋源建筑低层顶点的采样全部高出 10 米以上，总体中位差约 19.77 米。这个问题会遮住真实楼模的下部，不能通过任意抬高楼模来修复。

现采用**同一官方 2018 城区原档**内的 `LYON_1ER_2018/LYON_1ER_TIN_2018.gml` 地面层，许可仍为 Licence Ouverte 2.0。原文件 **68,241,039 字节、95,391 个原地面三角形、ZIP CRC32 `64bc37e7`**；完整 SHA-256 留在 `world-lyon-cityhall-terrain/source.json`。原 TIN 与建筑低层顶点高差的中位约 0.54 米，版本和位置相符。

生成独立的 **z14、256×256、3×3 张 Terrarium RGB PNG**，覆盖默认相机及周边约 5 公里范围，总 PNG **1,079,350 字节**。每个 Web Mercator 像素中心先转换到原 CC46 坐标，再在**原三角形内做重心插值**，不用重新生成三角网，也不进行平整、平滑或定高。TIN 实际覆盖的 34,082 个像素采用官方地面高程；其余像素逐字节保留原 Mapzen 的 RGB。原 Mapzen 缓存和所有楼模均未修改。普通 256 像素瓦片直接交给 MapLibre，由它处理相邻瓦片的一像素边界。

| 相同瓦片中的像素 | 原 Mapzen（米） | 官方 TIN Terrarium（米） |
| --- | ---: | ---: |
| 市政厅中心 | 185.203125 | 169.109375 |
| 歌剧院 | 184.2421875 | 169.359375 |
| 沃土广场 | 185.375 | 169.6640625 |
| 市政厅东街 | 182.69140625 | 168.8203125 |
| 市政厅南街 | 182.54296875 | 168.7109375 |

源高度按最近的 1/256 米编码，全部官方 TIN 像素的最大编码误差 **0.001953041 米**，小于 1/256 米。这里是**编码误差**；z14 像素间距约 6.7 米，栅格采样、源地面测量与高程基准各有自身限制，不能据此声称毫米级地理精度。这个栅格沿用前文明确的 NGF-IGN69 地方高程假设，直接与渲染转换后的楼模正高对应；TIN 外 Mapzen 值保持原状。

元数据保留每张原 Mapzen 缓存哈希、输出 PNG/像素哈希、方法、源 TIN 哈希，以及 30 组含原三角形与 CC46 坐标的验证样本。普通测试解码 PNG，验证原缓存未改、回退样本保真、原三角形重心插值与编码误差；显式原档审计另外读取原 TIN，核对全部 95,391 个条目数量、完整 SHA 和验证样本引用的原三角形。

仅重建地面可运行以下命令；准备脚本会缓存原 TIN，首次通过官方 ZIP 流读取到该成员后结束，不下载后续数 GB 照片。预先存在的九张无损 Mapzen 瓦片由 `scripts/cache-world.mjs` 生成。

```sh
python3 -c 'import runpy; runpy.run_path("scripts/prepare-world-scenes.py")["lyon_terrain"]()'
```

## 渲染时的垂直基准适配

已部署 3D Tiles 始终保留标准 **WGS84 ECEF 椭球高**。MapLibre / Terrarium 地图显示使用正高，渲染接合时才按当地公开网格的中心分离量 `N` 做 `H = h − N`，并同步相机目标高程。这是两种高程基准之间的转换，不是为贴底图任意加减模型高度。

| 片区 | 网格 | 配置 datumOffset（米） |
| --- | --- | ---: |
| 赫尔辛基大教堂 | EGM96 | -17.861190283495475 |
| 赫尔辛基中央车站 | EGM96 | -17.8792592381012 |
| 乌斯别斯基大教堂 | EGM96 | -17.845992744900286 |
| 赫尔辛基集市广场 | EGM96 | -17.85555812995881 |
| 岩石教堂 | EGM96 | -17.9077160730958 |
| 芬兰堡大庭院 | EGM96 | -17.79091656114906 |
| 里昂市政厅 | IGN RAF18 | -49.438497493949654 |

这些值仅用于片区局部渲染配准；原 ECEF 模型、原地理范围和 `source.json` 的椭球高范围不变。里昂的原垂直基准假设仍适用，背景 DEM 自身分辨率、城市屋顶混合与采集差异也不会因基准转换而消失。
