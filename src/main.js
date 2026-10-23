import { mapEngine } from './map-engine.js';
import { places, chapters, sources, themes, highlights, countryNames, continents, placeStories, matchesScope, coordinateLabel } from './atlas-content.js';
import { icon } from './icons.js';
import { addLandforms, loadLandformData, landformBounds } from './landforms.js';
import { installTileProtocol, setDetailTileCoverage } from './map-tiles.js';
import { terrainView } from './map-view.js';
import { realScene, realScenes as hongKongScenes, sceneCoverage } from './real-scene.js';
import { worldScenes } from './world-scenes.js';
import { addPlaceMarkers } from './map-markers.js';

const realScenes = [...worldScenes, ...hongKongScenes];
const worldProjection = { type: ['interpolate', ['linear'], ['zoom'], 5, 'globe', 7, 'mercator'] };

let maplibregl;
const assetUrl = path => {
  const relative = path.replace(/^\.?\//, '');
  const base = relative.startsWith('models/') && import.meta.env.VITE_MODEL_BASE_URL ? import.meta.env.VITE_MODEL_BASE_URL : import.meta.env.BASE_URL;
  return `${base}${relative}`;
};
const thumbnail = p => assetUrl(p.image.replace('/images/', '/images/thumbs/').replace(/\.jpg$/, '.webp'));
const warmSceneRenderer = () => { import('./real-scene-renderer.js').catch(() => {}); };

const $ = (selector) => document.querySelector(selector);
const reducedMotion = window.matchMedia('(prefers-reduced-motion: reduce)').matches;
const state = { category: 'all', continent: 'all', country: 'all', selected: null, landform: null, terrain: true, layer: 'satellite', borders: false, rivers: true, mountains: true, tour: false, tourIndex: 0, tourIds: highlights, mapReady: false, realScene: false };
const catalog = { theme: 'all', country: 'all', query: '' };
let tourTimer;
let map;
let terrainReady = false;
let sceneRenderer;
let sceneRequest = 0;
let sceneStatus = 'idle';
let activeScene = realScenes[0];
let landforms;
let updatePlaceMarkers;
let markerFrame;
let markerTimer;
let lastMarkerUpdate = 0;
const searchAliases = { everest: '珠峰 Everest Qomolangma', yangtze: '长江三峡 瞿塘峡 白帝城 夔门', guilin: '桂林漓江 阳朔', dunhuang: '敦煌月牙泉 鸣沙山', 'forbidden-city': '北京故宫 紫禁城 故宫博物院', 'great-wall': '金山岭长城 万里长城', qinghai: '青海湖 Qinghai Lake', dali: '大理古城 苍山洱海' };
let photos = {};
let detailPhotos = {};
let photoPlace;
let photoIndex = 0;
let photographyReady;
let provincesLoaded = false;
let outlineLoaded = false;
let coverageReady;
const tileManifests = new Map();
let geographyReady;

function loadTileCoverage() {
  return coverageReady ??= Promise.all(['tiles-detail.json', 'tiles-world.json'].map(name => tileManifests.has(name) ? tileManifests.get(name) : fetch(assetUrl(`data/${name}`), { priority: 'low', signal: AbortSignal.timeout(2500) }).then(response => {
    if (!response.ok) throw new Error('Tile manifest unavailable');
    return response.json();
  }).then(manifest => tileManifests.set(name, manifest)).catch(() => {}))).then(() => {
    setDetailTileCoverage(Object.fromEntries(['satellite', 'terrain', 'relief'].map(kind => [kind, [...tileManifests.values()].flatMap(manifest => manifest[kind] || [])])));
    if (tileManifests.size < 2) coverageReady = null;
  });
}

function enhanceGeography() {
  if (geographyReady) return geographyReady;
  geographyReady = addLandforms(map, selectLandform, loadLandformData()).then(controller => {
    landforms = controller;
    $('#landform-select').innerHTML += ['mountain', 'river'].map(kind => `<optgroup label="${kind === 'mountain' ? '主要山脉' : '主要河流'}">${landforms.features.filter(f => f.properties.kind === kind).map(f => `<option value="${f.properties.id}">${safeText(f.properties.name)}</option>`).join('')}</optgroup>`).join('');
    setLandformVisible('mountain', state.mountains); setLandformVisible('river', state.rivers);
  }).catch(error => { geographyReady = null; console.warn('Geography layers:', error); showToast('山系与水系暂未载入，请重试'); });
  return geographyReady;
}

function enhanceRegion() {
  if (state.realScene || !state.mapReady) return;
  const c = map.getCenter();
  if (map.getZoom() >= 3.3 && c.lng > 65 && c.lng < 145 && c.lat > 5 && c.lat < 60) {
    if (!outlineLoaded) { outlineLoaded = true; map.getSource('outline').setData(assetUrl('/data/china-outline.geojson')); }
    enhanceGeography();
  }
}

const app = $('#app');
app.innerHTML = `
  <main class="atlas world-atlas" aria-label="寰游，全球三维地理与文明图鉴">
    <div id="map" aria-label="可缩放、旋转的三维地球"></div>
    <div class="map-vignette"></div><div class="editorial-shade"></div>
    <header class="masthead">
      <a class="brand" href="#" aria-label="寰游，返回地球全景"><span class="brand-seal" aria-hidden="true">◎</span><span class="brand-word">寰游<span aria-hidden="true">ATLAS OF EARTH</span></span></a>
      <nav class="main-nav" aria-label="主导航">
        <button class="nav-link active" data-category="all">全球探索</button>
        <button class="nav-link" data-category="nature">自然奇境</button>
        <button class="nav-link" data-category="culture">文明地标</button>
        <button class="nav-link" id="chapters-button">主题旅程<span class="nav-new">${chapters.length}</span></button>
      </nav>
      <div class="header-actions"><button class="real-scenes-button" id="real-scenes-button" aria-pressed="false">实景地标 <span>${String(realScenes.length).padStart(2, '0')}</span></button><button class="icon-button search-toggle" aria-label="搜索全球目的地">${icon('search')}</button><button class="about-button" id="about-button">关于寰游 ${icon('arrow')}</button></div>
    </header>
    <section class="world-scope-bar" aria-label="按大洲和国家探索"><span class="scope-label">探索范围</span><div class="continent-options"><button class="continent-chip active" data-continent="all" aria-pressed="true">全球</button>${continents.map(name => `<button class="continent-chip" data-continent="${name}" aria-pressed="false">${name}</button>`).join('')}</div><label class="country-picker"><select id="country-select" aria-label="选择国家"><option value="all">全部国家 · ${countryNames.length}</option>${countryNames.map(name => `<option>${name}</option>`).join('')}</select></label></section>
    <section class="intro" aria-labelledby="hero-title">
      <div class="eyebrow"><span></span> ONE PLANET · ENDLESS DISCOVERY</div>
      <h1 id="hero-title">世界，<span>近在眼前。</span></h1>
      <p class="intro-copy">旋转地球，走近自然奇境与文明地标。<br>从一个坐标，重新认识世界。</p>
      <button class="primary-button" id="explore-button">选择目的地 ${icon('arrow')}</button>
      <button class="tour-link" id="intro-tour">${icon('play')} 环游世界 <span>12 站 · 约 2 分钟</span></button>
    </section>
    <aside class="place-panel" aria-label="地点介绍" hidden></aside>
    <div class="map-caption"><span class="live-dot"></span> 地球全景 <span class="caption-divider">/</span><span id="map-mode">三维地球 · 自由探索</span></div>
    <section class="real-scene-toolbar" aria-label="城市实景控制" hidden><div><span class="scene-eyebrow">REAL WORLD / 高保真实景</span><label class="scene-picker-label" for="scene-picker">切换实景片区</label><select id="scene-picker">${realScenes.map(s => `<option value="${s.id}">${s.name}</option>`).join('')}</select><p data-scene-status role="status" aria-live="polite"></p></div><div class="scene-tools"><button id="scene-center">回到片区 ${icon('pin')}</button><button id="scene-close">卫星影像 ${icon('close')}</button></div><p class="scene-scope"><span data-scene-coverage>金色虚线内为当前实景片区，其他地区仍为卫星影像。</span><br><span data-scene-attribution></span></p></section>
    <div class="map-controls" aria-label="地图控制">
      <button class="compass-button" id="north-button" aria-label="恢复正北方向"><span>N</span>${icon('compass')}</button>
      <div class="control-group"><button id="zoom-in" aria-label="放大地图">${icon('plus')}</button><button id="zoom-out" aria-label="缩小地图">${icon('minus')}</button></div>
      <div class="control-group"><button id="terrain-button" class="is-active" aria-label="3D，切换三维地形" aria-pressed="true"><span class="dimension">3D</span></button><button id="home-button" aria-label="回到地球全景">${icon('home')}</button><button id="fullscreen-button" aria-label="进入全屏">${icon('full')}</button></div>
    </div>
    <div class="map-bottom-tools">
      <div class="landform-legend" aria-label="山系与水系图例"><button data-landform-kind="mountain" aria-pressed="true" title="显示或隐藏主要山脉"><i class="mountain-key"></i>山脉走向</button><button data-landform-kind="river" aria-pressed="true" title="显示或隐藏主要河流"><i class="river-key"></i>主要河流</button></div>
      <button class="layers-button" id="layers-button" aria-expanded="false">${icon('layers')} <span>地图图层</span> ${icon('down')}</button>
      <div class="layer-picker" hidden><h3>以不同视角，看见地球</h3><div class="basemap-options"><button class="basemap active" data-layer="satellite"><span class="basemap-thumb satellite-thumb"></span>卫星影像</button><button class="basemap" data-layer="relief"><span class="basemap-thumb relief-thumb"></span>地形晕渲</button></div><label><span>中国省级行政区划</span><input type="checkbox" id="border-toggle"></label><label><span><i class="mountain-key"></i>中国山脉 · 走向示意</span><input type="checkbox" id="mountain-toggle" checked></label><label><span><i class="river-key"></i>中国水系 · 概览中心线</span><input type="checkbox" id="river-toggle" checked></label><select id="landform-select" aria-label="按名称定位山脉或河流"><option value="">按名称定位山脉或河流…</option></select><p class="landform-hint">点击线条或名称，读懂山河。<br>放大后渐隐概览线，观察真实地形。</p></div>
      <span class="map-gesture">${icon('compass')} 拖动探索 · 滚轮缩放 · 右键旋转</span>
    </div>
      <div class="tour-player" hidden><button id="tour-pause" aria-label="暂停漫游">${icon('pause')}</button><span><small>世界漫游</small><strong id="tour-place"></strong></span><span id="tour-count"></span><button id="tour-next" aria-label="下一个地点">${icon('chevron')}</button><button id="tour-close" aria-label="结束漫游">${icon('close')}</button><div class="tour-progress"></div></div>
    <div class="explore-dock"><button id="discover-toggle" aria-expanded="false" aria-controls="destination-discovery">${icon('compass')}<span>展开精选</span>${icon('down', 'dock-chevron')}</button><button id="world-catalog-button">全球目录 ${icon('arrow')}</button><span class="dock-stats">${countryNames.length} 国 · ${places.length} 个坐标</span></div>
    <section class="discover" id="destination-discovery" aria-label="精选目的地" hidden>
      <div class="discover-heading"><div><span class="section-index">01 / DISCOVER</span><h2 id="discover-title">从地球出发，发现世界</h2></div><span class="discover-note" id="discover-note">每一个坐标，都是一个新世界</span><button class="catalog-button" id="catalog-button">全球目录 <span>${places.length}</span> ${icon('arrow')}</button><div class="carousel-controls"><button id="cards-prev" aria-label="向前浏览目的地">${icon('chevron')}</button><button id="cards-next" aria-label="向后浏览目的地">${icon('chevron')}</button></div></div>
      <div class="destination-track" id="destination-track"></div>
    </section>
    <footer class="map-footer"><span><span class="live-dot"></span> <span id="map-status">正在唤醒地球…</span></span><span class="footer-attribution">© Esri, Vantor, Earthstar Geographics · Mapzen</span><span class="coordinates" id="coordinates">30.00° E &nbsp; 22.00° N</span><button id="sources-button">数据来源与地图说明 ${icon('info')}</button></footer>
    <div class="toast" role="status" aria-live="polite"></div>
  </main>
  <dialog class="search-dialog" aria-labelledby="search-title"><div class="dialog-top"><span id="search-title">寻找世界的一个坐标</span><button class="icon-button" data-close aria-label="关闭搜索">${icon('close')}</button></div><div class="search-input-wrap">${icon('search')}<input id="search-input" type="search" placeholder="搜索景点、国家、自然与文明地标…" autocomplete="off" aria-label="搜索地点"><kbd>ESC</kbd></div><div class="search-results"></div><p class="search-hint">从 ${places.length} 个精选坐标出发，去认识世界。</p></dialog>
  <dialog class="story-dialog" aria-labelledby="story-title"></dialog>
  <dialog class="catalog-dialog" aria-labelledby="catalog-title"></dialog>
  <dialog class="about-dialog" aria-labelledby="about-title"></dialog>
  <dialog class="photo-dialog" aria-labelledby="photo-title"><div class="dialog-top"><span id="photo-title"></span><button class="icon-button" data-close aria-label="关闭照片">${icon('close')}</button></div><div class="photo-viewer-content"></div><div class="photo-viewer-controls"><button id="photo-prev" aria-label="上一张照片">${icon('chevron')}</button><span id="photo-count" role="status" aria-live="polite"></span><button id="photo-next" aria-label="下一张照片">${icon('chevron')}</button></div></dialog>
`;

function filteredPlaces() { return places.filter(p => (state.category === 'all' || p.category === state.category) && matchesScope(p, state.continent, state.country)); }

function setDiscoveryOpen(open, reframe = true) {
  if (open && innerWidth <= 700 && (state.selected || state.landform)) resetView(false);
  $('.discover').hidden = !open;
  $('.atlas').classList.toggle('catalog-open', open);
  $('#discover-toggle').setAttribute('aria-expanded', String(open));
  $('#discover-toggle span').textContent = open ? '收起精选' : '展开精选';
  if (open) renderCards();
  if (reframe && state.mapReady) map.easeTo({ padding: mapPadding(), duration: reducedMotion ? 0 : 300 });
}

function updateScopeUI() {
  document.querySelectorAll('[data-continent]').forEach(button => {
    const active = button.dataset.continent === state.continent;
    button.classList.toggle('active', active);
    button.setAttribute('aria-pressed', String(active));
  });
  const countries = countryNames.filter(name => places.some(place => place.country === name && (state.continent === 'all' || place.continent === state.continent)));
  $('#country-select').innerHTML = `<option value="all">${state.continent === 'all' ? '全部国家' : state.continent} · ${countries.length}</option>${countries.map(name => `<option>${name}</option>`).join('')}`;
  $('#country-select').value = state.country;
  $('.dock-stats').textContent = `${state.country !== 'all' ? state.country : state.continent !== 'all' ? state.continent : `${countryNames.length} 国`} · ${filteredPlaces().length} 个坐标`;
}

function focusScope() {
  if (!state.mapReady) return;
  const continentViews = { 亚洲: [[95, 29], 2.5], 欧洲: [[14, 49], 3.2], 非洲: [[21, 3], 2.5], 北美洲: [[-105, 39], 2.5], 南美洲: [[-64, -20], 2.7], 大洋洲: [[147, -27], 3] };
  if (state.country !== 'all') {
    if (state.country === '中国') map.flyTo({ center: [103, 35.5], zoom: innerWidth > 700 ? 3.6 : 2.6, pitch: 30, bearing: 0, padding: mapPadding(), duration: reducedMotion ? 0 : 1800 });
    else {
      const points = places.filter(place => place.country === state.country).map(place => place.coordinate);
      const bounds = points.reduce((box, [x, y]) => [[Math.min(box[0][0], x), Math.min(box[0][1], y)], [Math.max(box[1][0], x), Math.max(box[1][1], y)]], [[180, 90], [-180, -90]]);
      map.fitBounds(bounds, { padding: mapPadding(), maxZoom: points.length === 1 ? 5 : 5.5, pitch: 0, bearing: 0, duration: reducedMotion ? 0 : 1800 });
    }
  } else if (state.continent !== 'all') {
    const [center, zoom] = continentViews[state.continent];
    map.flyTo({ center, zoom: zoom - (innerWidth <= 700 ? .65 : 0), pitch: 0, bearing: 0, padding: mapPadding(), duration: reducedMotion ? 0 : 1800 });
  } else map.flyTo({ ...overviewCamera(), duration: reducedMotion ? 0 : 1800 });
}

function changeScope(continent, country = 'all') {
  state.continent = continent; state.country = country;
  resetView(false);
  updateScopeUI(); renderCards(); focusScope();
  $('.map-caption').innerHTML = `<span class="live-dot"></span> ${country !== 'all' ? country : continent !== 'all' ? continent : '地球全景'} <span class="caption-divider">/</span><span id="map-mode">${currentView().label}</span>`;
}
function renderCards() {
  if ($('.discover').hidden) { scheduleMarkers(); return; }
  $('#destination-track').innerHTML = filteredPlaces().map((p) => `<button class="destination-card ${state.selected === p.id ? 'selected' : ''}" data-place="${p.id}" aria-labelledby="card-title-${p.id}"><img src="${thumbnail(p)}" alt="" width="480" height="300" decoding="async" fetchpriority="low" loading="lazy"><span class="card-shade"></span><span class="card-order" aria-hidden="true">${String(places.indexOf(p) + 1).padStart(2, '0')}</span><span class="card-tag" aria-hidden="true">${p.country} · ${p.category === 'culture' ? '文明' : '自然'}</span><span class="card-title"><span id="card-title-${p.id}"><strong>${p.name}</strong><small>${p.en.toUpperCase()}</small></span><span class="card-arrow">${icon('arrow')}</span></span></button>`).join('');
  $('#destination-track').querySelectorAll('[data-place]').forEach(b => b.onclick = () => selectPlace(b.dataset.place));
  scheduleMarkers();
}

function safeText(text) { const el = document.createElement('span'); el.textContent = text; return el.innerHTML.replaceAll('"', '&quot;'); }
function showToast(message) { $('.toast').textContent = message; $('.toast').classList.add('visible'); clearTimeout(showToast.timer); showToast.timer = setTimeout(() => $('.toast').classList.remove('visible'), 3200); }
function photoCredit(c) { return `<a href="${c.sourceUrl}" target="_blank" rel="noopener noreferrer">摄影：${safeText(c.attribution || c.author)}</a> · <a href="${c.licenseUrl}" target="_blank" rel="noopener noreferrer">${safeText(c.license)}</a><br>图片经缩放与压缩，原作及许可见链接。`; }
function placeGallery(p) { return [{ ...photos[p.id], file: p.image, caption: photos[p.id]?.location || p.name, alt: photos[p.id]?.location || `${p.name}风光` }, detailPhotos[p.id]].filter(Boolean); }
function renderPhoto() {
  const gallery = placeGallery(photoPlace);
  const photo = gallery[photoIndex];
  $('#photo-title').textContent = `${photoPlace.name} / 地球影像`;
  $('.photo-viewer-content').innerHTML = `<figure><img src="${assetUrl(photo.file)}" alt="${safeText(photo.alt)}"><figcaption>${safeText(photo.caption)}</figcaption></figure><p class="photo-credit">${photo.author ? photoCredit(photo) : '摄影资料载入中…'}</p>`;
  $('#photo-count').textContent = `${String(photoIndex + 1).padStart(2, '0')} / ${String(gallery.length).padStart(2, '0')}`;
}
function openPhoto(p, index) {
  stopTour(); photoPlace = p; photoIndex = index; renderPhoto();
  $('.photo-dialog').showModal();
}
function stepPhoto(direction) { photoIndex = (photoIndex + direction + placeGallery(photoPlace).length) % placeGallery(photoPlace).length; renderPhoto(); }
function setReadingExpanded(expanded) {
  const panel = $('.place-panel');
  panel.classList.toggle('reading-expanded', expanded);
  $('.reading-toggle').setAttribute('aria-expanded', String(expanded));
  $('.reading-toggle').innerHTML = `${expanded ? '收起阅读' : '展开阅读'} ${icon('down')}`;
  if (expanded) stopTour();
}
function renderPlace(p, preserveReading = false) {
  loadPhotography();
  $('.intro').classList.add('dismissed');
  const panel = $('.place-panel');
  const scrollTop = preserveReading ? $('.place-scroll')?.scrollTop || 0 : 0;
  panel.classList.remove('landform-detail');
  panel.classList.add('place-reading');
  if (!preserveReading) panel.classList.remove('reading-expanded');
  panel.hidden = false;
  const story = placeStories[p.id];
  const detail = detailPhotos[p.id];
  const placeScene = realScenes.find(scene => scene.placeId === p.id);
  const scenePrompt = placeScene ? `<section class="scene-prompt"><span>${placeScene.kind === 'reconstruction' ? 'TEXTURED MODEL / 真实纹理建筑' : 'PHOTO REAL / 航拍摄影模型'}</span><h4>走近${p.name}的真实空间</h4><p>${safeText(placeScene.scope || '在已开放片区内，旋转观察真实建筑形态与摄影纹理。')}</p><button class="scene-action">${state.realScene ? '返回卫星影像' : '进入三维实景'} ${icon('arrow')}</button></section>` : p.country !== '中国' && p.terrain === false ? '<p class="scene-availability">当前为卫星影像，此地标的摄影实景模型尚未接入。</p>' : '';
  const detailFigure = detail ? `<figure class="place-photo"><button data-photo="1" aria-label="查看${p.name}第二张照片"><img src="${assetUrl(detail.file)}" alt="${safeText(detail.alt)}" loading="lazy" width="${detail.width}" height="${detail.height}"><span>${icon('full')} 查看大图</span></button><figcaption><span>02 / 风景细读</span>${safeText(detail.caption)}</figcaption><details class="photo-attribution"><summary>摄影与许可</summary><p class="photo-credit">${photoCredit(detail)}</p></details></figure>` : '';
  panel.innerHTML = `<div class="place-toolbar"><span>地点手记 <small>/ FIELD NOTES</small></span><button class="reading-toggle" aria-expanded="false" aria-controls="place-reading-content">展开阅读 ${icon('down')}</button><button class="panel-back" aria-label="关闭地点手记">${icon('close')}</button></div><div class="place-scroll" id="place-reading-content"><div class="place-cover"><img src="${assetUrl(p.image)}" alt="${safeText(placeGallery(p)[0].alt)}" decoding="async"><div class="place-cover-shade"></div><button class="cover-photo-button" data-photo="0" aria-label="查看${p.name}第一张照片"><span>${icon('full')} 查看照片</span></button><span class="place-category">${p.category === 'culture' ? '人文足迹 · CULTURE' : '自然奇境 · NATURE'}</span><h2>${p.name}<small>${p.en.toUpperCase()}</small></h2></div><div class="place-body"><div class="place-location">${icon('pin')} ${p.region}<span>${coordinateLabel(p.coordinate)}</span></div>${scenePrompt}<p class="place-kicker">${p.kicker}</p><h3>${p.title}</h3><p class="place-description">${p.description}</p><div class="place-stats">${p.stats.map(s => `<div><strong>${s.value}</strong><small>${s.label}</small></div>`).join('')}</div><div class="place-paragraphs"><section class="place-chapter"><h4><span>01</span>${story.chapterTitles[0]}</h4><p>${p.paragraphs[0]}</p></section>${detailFigure}<section class="place-chapter"><h4><span>02</span>${story.chapterTitles[1]}</h4><p>${p.paragraphs[1]}</p></section><section class="place-observation"><span class="observation-label">${icon('compass')} 观察手记</span><h4>在这里，看见什么</h4><p>${story.observation}</p></section></div><div class="place-tags">${p.tags.map(t => `<span>${t}</span>`).join('')}</div><a class="place-source" href="${p.source.url}" target="_blank" rel="noopener noreferrer">延伸阅读 · ${p.source.label} ${icon('arrow')}</a><details class="photo-attribution cover-attribution"><summary>封面摄影与许可</summary><p class="photo-credit">${photos[p.id] ? photoCredit(photos[p.id]) : '摄影资料载入中…'}</p></details></div></div>`;
  $('.panel-back').onclick = resetView;
  $('.reading-toggle').onclick = () => setReadingExpanded(!panel.classList.contains('reading-expanded'));
  if (panel.classList.contains('reading-expanded')) setReadingExpanded(true);
  panel.querySelectorAll('[data-photo]').forEach(b => b.onclick = () => openPhoto(p, Number(b.dataset.photo)));
  const sceneAction = panel.querySelector('.scene-action');
  if (sceneAction) {
    sceneAction.onclick = () => state.realScene ? closeRealScene() : startRealScene(placeScene);
    sceneAction.onpointerenter = sceneAction.onfocus = warmSceneRenderer;
  }
  $('.place-scroll').scrollTop = scrollTop;
}

function selectPlace(id, fromTour = false, skipCamera = false) {
  const p = places.find(p => p.id === id);
  if (!p) return;
  if (!matchesScope(p, state.continent, state.country)) {
    state.continent = 'all'; state.country = 'all'; updateScopeUI(); renderCards();
  }
  if (state.category !== 'all' && p.category !== state.category) changeCategory('all');
  if (!fromTour) stopTour();
  stopRealScene();
  setDiscoveryOpen(false, false);
  state.landform = null; landforms?.clear();
  $('#landform-select').value = '';
  state.selected = p.id;
  renderPlace(p);
  updateCardSelection();
  updatePlaceMarkers?.(state);
  $('.map-caption').innerHTML = `<span class="live-dot"></span> ${p.name} <span class="caption-divider">/</span><span id="map-mode">${terrainView(p, state.terrain).label}</span>`;
  applyTerrain();
  if (map && state.mapReady && !skipCamera) loadTileCoverage().then(() => {
    if (state.selected === p.id && !state.realScene) map.flyTo({ ...placeCamera(p), duration: reducedMotion ? 0 : 900, essential: true });
  });
  history.replaceState(null, '', `#${p.id}`);
}

function selectLandform(feature) {
  if (!feature) return;
  stopTour(); stopRealScene(); state.selected = null; state.landform = feature.properties.id;
  applyTerrain();
  const p = feature.properties;
  setLandformVisible(p.kind, true);
  landforms.select(feature);
  updatePlaceMarkers?.(state);
  $('.intro').classList.add('dismissed');
  const panel = $('.place-panel');
  panel.classList.remove('place-reading', 'reading-expanded');
  panel.hidden = false; panel.classList.add('landform-detail'); panel.scrollTop = 0;
  panel.innerHTML = `<div class="landform-heading"><span class="landform-eyebrow"><i class="${p.kind === 'mountain' ? 'mountain' : 'river'}-key"></i>${p.kind === 'mountain' ? '大地的骨架 / MOUNTAIN RANGES' : '大地的脉络 / RIVER SYSTEMS'}</span><button class="panel-back" aria-label="关闭地点手记">${icon('close')}</button><h2>${safeText(p.name)}<small>${safeText(p.name_en)}</small></h2></div><div class="place-body"><p class="landform-description">${safeText(p.description)}</p>${p.direction ? `<div class="landform-fact"><span>总体走向</span>${safeText(p.direction)}</div>` : ''}${p.basin ? `<div class="landform-fact"><span>所属水系</span>${safeText(p.basin)}</div>` : ''}<p class="landform-precision">${safeText(p.precision_note)}</p><a class="place-source" href="${p.source}" target="_blank" rel="noopener noreferrer">${p.kind === 'mountain' ? '地理资料与延伸阅读' : '水系数据与比例尺说明'} ${icon('arrow')}</a><p class="landform-interaction">拖动、旋转地图，观察山河之间的关系。</p></div>`;
  $('.panel-back').onclick = resetView;
  updateCardSelection();
  map.fitBounds(landformBounds(feature), { padding: mapPadding(), absolutePadding: true, maxZoom: 6.5, pitch: state.terrain ? 40 : 0, bearing: -8, duration: reducedMotion ? 0 : 1800 });
  $('.map-caption').innerHTML = `<span class="live-dot"></span> ${safeText(p.name)} <span class="caption-divider">/</span><span id="map-mode">${state.terrain ? '三维地形已开启' : '平面地图'}</span>`;
  $('.layer-picker').hidden = true; $('#layers-button').setAttribute('aria-expanded', 'false'); $('#layers-button').classList.remove('active');
  $('#landform-select').value = p.id;
  history.replaceState(null, '', location.pathname);
}

function setLandformVisible(kind, visible) {
  state[kind === 'mountain' ? 'mountains' : 'rivers'] = visible;
  $(`#${kind}-toggle`).checked = visible;
  $(`[data-landform-kind="${kind}"]`).setAttribute('aria-pressed', String(visible));
  landforms?.setVisible(kind, visible);
  scheduleMarkers();
}

function sceneCamera() {
  return { center: activeScene.center, zoom: activeScene.zoom, pitch: activeScene.pitch, bearing: activeScene.bearing, elevation: activeScene.elevation, padding: mapPadding() };
}

function updateSceneUI() {
  $('.atlas').classList.toggle('scene-active', state.realScene);
  $('.real-scene-toolbar').hidden = !state.realScene;
  $('#real-scenes-button').setAttribute('aria-pressed', String(state.realScene));
  $('#scene-picker').value = activeScene.id;
  $('[data-scene-coverage]').textContent = activeScene.scope || '金色虚线内为当前实景片区，其他地区仍为卫星影像。';
  $('[data-scene-attribution]').innerHTML = `${safeText(activeScene.attribution || '© 香港特别行政区政府 · 地政总署 / CSDI')} · <a href="${activeScene.sourceUrl}" target="_blank" rel="noopener noreferrer">数据来源</a> · <a href="${activeScene.licenseUrl}" target="_blank" rel="noopener noreferrer">使用条款</a>`;
  $('[data-scene-status]').textContent = sceneStatus === 'ready' ? '真实纹理已载入 · 拖动、右键旋转探索' : '正在加载真实建筑与航拍纹理…';
  const action = $('.scene-action');
  if (action) action.innerHTML = `${state.realScene ? '返回卫星影像' : '进入实景片区'} ${icon('arrow')}`;
}

function stopRealScene() {
  const wasRealScene = state.realScene;
  state.realScene = false;
  sceneStatus = 'idle';
  sceneRequest++;
  sceneRenderer?.destroy();
  sceneRenderer = null;
  if (state.mapReady) {
    if (wasRealScene) {
      const sceneTerrain = `terrain-${activeScene.id}`;
      if (map.getSource(sceneTerrain)) {
        map.setTerrain(null);
        map.removeSource(sceneTerrain);
      }
      map.setProjection(worldProjection);
      map.setCenterClampedToGround(true);
      map.setCenterElevation(0);
    }
    map.setMaxZoom(18);
    if (map.getLayer('real-scene-boundary')) map.setLayoutProperty('real-scene-boundary', 'visibility', 'none');
  }
  updateSceneUI();
}

function closeRealScene() {
  if (!state.realScene) return;
  stopRealScene();
  const p = places.find(p => p.id === state.selected);
  $('.map-caption').innerHTML = `<span class="live-dot"></span> ${p.name} <span class="caption-divider">/</span><span id="map-mode"></span>`;
  applyTerrain();
  map?.easeTo({ pitch: currentView().pitch, padding: mapPadding(), duration: reducedMotion ? 0 : 700 });
  history.replaceState(null, '', `#${p.id}`);
}

async function activateRealScene() {
  const request = ++sceneRequest;
  const scene = activeScene;
  // deck.gl requires a named projection, while the atlas interpolates its globe.
  map.setProjection({ type: 'mercator' });
  map.setMaxZoom(19);
  if (!map.getSource('real-scene-coverage')) {
    map.addSource('real-scene-coverage', { type: 'geojson', data: sceneCoverage(scene) });
    map.addLayer({ id: 'real-scene-boundary', type: 'line', source: 'real-scene-coverage', paint: { 'line-color': '#edd09b', 'line-width': 1.5, 'line-dasharray': [4, 3], 'line-opacity': .85 } });
  } else map.getSource('real-scene-coverage').setData(sceneCoverage(scene));
  map.setLayoutProperty('real-scene-boundary', 'visibility', 'visible');
  const onStatus = (status, detail) => {
    if (request !== sceneRequest || !state.realScene) return;
    if (status === 'error') {
      console.warn('City scene:', detail);
      closeRealScene();
      showToast('实景暂未载入，已返回卫星影像。可点击实景地标重试。');
      return;
    }
    sceneStatus = status;
    updateSceneUI();
    applyTerrain();
  };
  try {
    const { createRealSceneRenderer } = await import('./real-scene-renderer.js');
    if (request !== sceneRequest || !state.realScene) return;
    const codecs = scene.compressed ? await (await import('./real-scene-codecs.js')).loadSceneCodecs(assetUrl('codecs/')) : undefined;
    if (request !== sceneRequest || !state.realScene) return;
    const modelUrl = scene.pcUrl || scene.url;
    const renderer = createRealSceneRenderer(map, { url: assetUrl(modelUrl), center: scene.center, datumOffset: scene.datumOffset || 0, codecs, onStatus });
    if (request !== sceneRequest || !state.realScene) renderer.destroy();
    else sceneRenderer = renderer;
  } catch (error) {
    console.warn('City scene:', error);
    onStatus('error');
  }
}

function startRealScene(scene = activeScene) {
  if (state.realScene && scene.id === activeScene.id) {
    map?.flyTo({ ...sceneCamera(), duration: reducedMotion ? 0 : 1200 });
    return;
  }
  map?.stop();
  selectPlace(scene.placeId, false, true);
  activeScene = scene;
  // Set the camera's target altitude before checking coverage at the new location.
  // MapLibre's animated camera preserves elevation when ground clamping is off.
  if (state.mapReady) {
    map.setCenterClampedToGround(false);
    map.setCenterElevation(scene.elevation);
  }
  state.realScene = true;
  sceneStatus = 'loading';
  updateSceneUI();
  $('.map-caption').innerHTML = `<span class="live-dot"></span> ${activeScene.name} <span class="caption-divider">/</span><span id="map-mode"></span>`;
  applyTerrain();
  if (state.mapReady) {
    map.setProjection({ type: 'mercator' });
    map.jumpTo(sceneCamera());
    activateRealScene();
  }
  history.replaceState(null, '', `#${activeScene.id}`);
}

function mapPadding() {
  const cardsOpen = !$('.discover').hidden;
  if (innerWidth > 700) {
    const panel = $('.place-panel');
    return { left: !panel.hidden && !state.realScene ? panel.getBoundingClientRect().right + 24 : 50, right: state.realScene ? 320 : 85, top: 125, bottom: cardsOpen ? 295 : 100 };
  }
  if (state.realScene) return { left: 15, right: 55, top: $('.real-scene-toolbar').getBoundingClientRect().bottom + 16, bottom: 95 };
  if (!state.selected && !state.landform) return { left: 25, right: 55, top: 180, bottom: cardsOpen ? 290 : 90 };
  const mapRect = $('#map').getBoundingClientRect();
  const panel = $('.place-panel');
  const style = getComputedStyle(panel);
  const panelTop = panel.classList.contains('reading-expanded') ? mapRect.height - parseFloat(style.getPropertyValue('--place-compact-bottom')) - parseFloat(style.getPropertyValue('--place-compact-height')) : panel.getBoundingClientRect().top - mapRect.top;
  return { left: 15, right: 55, top: $('.tour-player').hidden ? 180 : 220, bottom: Math.max(95, mapRect.height - panelTop + 20) };
}
function resetView(fly = true) {
  stopTour(); stopRealScene(); state.selected = null; state.landform = null; landforms?.clear();
  applyTerrain();
  $('.place-panel').hidden = true; $('.place-panel').classList.remove('landform-detail', 'place-reading', 'reading-expanded'); $('.intro').classList.remove('dismissed');
  $('#landform-select').value = '';
  updatePlaceMarkers?.(state);
  updateCardSelection();
  if (fly && map && state.mapReady) focusScope();
  $('.map-caption').innerHTML = `<span class="live-dot"></span> ${state.country !== 'all' ? state.country : state.continent !== 'all' ? state.continent : '地球全景'} <span class="caption-divider">/</span><span id="map-mode">三维地球 · 自由探索</span>`;
  history.replaceState(null, '', location.pathname);
}

function changeCategory(category) {
  stopTour(); state.category = category;
  $('.main-nav').querySelectorAll('[data-category]').forEach(b => b.classList.toggle('active', b.dataset.category === category));
  $('#discover-title').textContent = { all: '从地球出发，发现世界', nature: '大地写下的自然史诗', culture: '文明，留下可见的坐标' }[category];
  $('#discover-note').textContent = category === 'all' ? '每一个坐标，都是一个新世界' : `${filteredPlaces().length} 个精选坐标 · ${category === 'nature' ? '大地的自然史诗' : '土地上的千年故事'}`;
  renderCards(); $('#destination-track').scrollTo({ left: 0 });
  updateScopeUI();
  if (state.selected && !filteredPlaces().some(p => p.id === state.selected)) resetView();
}

function startTour(ids = highlights) {
  if (state.category !== 'all') changeCategory('all');
  if (!state.mapReady) return showToast('地图正在载入，请稍候片刻');
  stopTour(); state.tour = true; state.tourIds = ids; state.tourIndex = 0;
  $('.tour-player').hidden = false; $('.map-gesture').hidden = true;
  tourStep();
}
function tourStep() {
  clearTimeout(tourTimer);
  const p = places.find(p => p.id === state.tourIds[state.tourIndex]);
  selectPlace(p.id, true);
  $('#tour-place').textContent = p.name; $('#tour-count').textContent = `${String(state.tourIndex + 1).padStart(2, '0')} / ${state.tourIds.length}`;
  $('#tour-pause').innerHTML = icon('pause'); $('#tour-pause').setAttribute('aria-label', '暂停漫游');
  $('.tour-progress').classList.remove('running'); void $('.tour-progress').offsetWidth; $('.tour-progress').classList.add('running');
  tourTimer = setTimeout(nextTour, 11000);
}
function nextTour() { state.tourIndex++; if (state.tourIndex >= state.tourIds.length) { stopTour(); showToast('这段旅程已完成。继续探索世界的下一个坐标。'); } else { state.tour = true; tourStep(); } }
function stopTour() { clearTimeout(tourTimer); state.tour = false; $('.tour-player').hidden = true; $('.map-gesture').hidden = false; $('.tour-progress').classList.remove('running'); }

function openSearch() { renderSearch(''); $('.search-dialog').showModal(); $('#search-input').value = ''; $('#search-input').focus(); }
function matchesQuery(p, query) {
  return `${p.name} ${p.en} ${p.id} ${searchAliases[p.id] || ''} ${(p.aliases || []).join(' ')} ${p.country} ${p.continent} ${p.province} ${p.region} ${p.tags.join(' ')} ${p.description}`.toLowerCase().includes(query.trim().toLowerCase());
}
function renderSearch(query) {
  const found = places.filter(p => matchesQuery(p, query));
  $('.search-results').innerHTML = found.length ? found.map(p => `<button data-place="${p.id}"><img src="${thumbnail(p)}" alt="" loading="lazy" decoding="async"><span><strong>${p.name}</strong><small>${p.region} · ${p.tags[0]}</small></span><span class="result-category">${p.category === 'culture' ? '人文' : '自然'}</span>${icon('arrow')}</button>`).join('') : `<div class="empty-search">${icon('compass')}<h3>这里还没有收录这个坐标</h3><p>试试「法国」「金字塔」「富士山」或「冰川」。</p></div>`;
  $('.search-results').querySelectorAll('[data-place]').forEach(b => b.onclick = () => { $('.search-dialog').close(); selectPlace(b.dataset.place); });
}

function openCatalog() {
  catalog.theme = 'all'; catalog.country = 'all'; catalog.query = '';
  $('.catalog-dialog').innerHTML = `<div class="catalog-sticky"><div class="dialog-top"><span>全球目录 / WORLD FIELD GUIDE</span><button class="icon-button" data-close aria-label="关闭全球目录">${icon('close')}</button></div><div class="catalog-intro"><div><span class="eyebrow">${countryNames.length} 个国家 · ${themes.length} 类探索线索</span><h2 id="catalog-title">世界，远不止一种风景。</h2></div><span class="catalog-total">${places.length}<small>个探索坐标</small></span></div><div class="catalog-themes" aria-label="按主题筛选"><button data-theme="all" class="active" aria-pressed="true">全部景观 <span>${places.length}</span></button>${themes.map(t => `<button data-theme="${t.id}" aria-pressed="false">${t.label} <span>${places.filter(p => p.theme === t.id).length}</span></button>`).join('')}</div><div class="catalog-filters"><label class="catalog-search">${icon('search')}<input id="catalog-search" type="search" placeholder="搜索景点、国家与文化地标…" aria-label="搜索全球目录"></label><select id="catalog-country" aria-label="按国家筛选"><option value="all">全部国家 · ${countryNames.length}</option>${countryNames.map(name => `<option>${name}</option>`).join('')}</select></div></div><div class="catalog-results-heading" role="status" aria-live="polite"></div><div class="catalog-grid"></div>`;
  $('.catalog-dialog [data-close]').onclick = () => $('.catalog-dialog').close();
  $('.catalog-themes').querySelectorAll('button').forEach(b => b.onclick = () => { catalog.theme = b.dataset.theme; $('.catalog-themes').querySelectorAll('button').forEach(el => { el.classList.toggle('active', el === b); el.setAttribute('aria-pressed', String(el === b)); }); renderCatalog(); });
  $('#catalog-search').oninput = e => { catalog.query = e.target.value; renderCatalog(); };
  $('#catalog-country').onchange = e => { catalog.country = e.target.value; renderCatalog(); };
  renderCatalog(); $('.catalog-dialog').showModal();
}

function renderCatalog() {
  const found = places.filter(p => (catalog.theme === 'all' || p.theme === catalog.theme) && (catalog.country === 'all' || p.country === catalog.country) && matchesQuery(p, catalog.query));
  $('.catalog-results-heading').textContent = `${catalog.country === 'all' ? '辽阔世界' : catalog.country} / ${themes.find(t => t.id === catalog.theme)?.label || '全部景观'} · ${found.length} 个坐标`;
  $('.catalog-dialog').scrollTop = 0;
  $('.catalog-grid').innerHTML = found.length ? found.map(p => `<button class="catalog-card" data-place="${p.id}"><div class="catalog-image"><img src="${thumbnail(p)}" alt="" loading="lazy" decoding="async"><span>${themes.find(t => t.id === p.theme).label}</span></div><div class="catalog-card-body"><small>${p.region}</small><strong>${p.name} ${icon('arrow')}</strong><p>${p.description}</p></div></button>`).join('') : `<div class="empty-search">${icon('compass')}<h3>这条线索下还没有找到坐标</h3><p>换一个主题、地区或搜索词，继续发现世界。</p><button class="catalog-clear">清除筛选 ${icon('arrow')}</button></div>`;
  $('.catalog-grid').querySelectorAll('[data-place]').forEach(b => b.onclick = () => { $('.catalog-dialog').close(); selectPlace(b.dataset.place); });
  const clear = $('.catalog-clear'); if (clear) clear.onclick = openCatalog;
}

function openChapters() {
  $('.story-dialog').innerHTML = `<div class="dialog-top"><span>世界旅程 / EDITORIAL JOURNEYS</span><button class="icon-button" data-close aria-label="关闭专题">${icon('close')}</button></div><div class="story-intro"><span class="eyebrow">换一个角度，理解脚下的土地</span><h2 id="story-title">沿着一条线索，读懂世界。</h2><p>${chapters.length} 条主题路线，${places.length} 个探索坐标。让镜头带你读懂自然与文明的相遇。</p></div><div class="chapter-grid">${chapters.map((c, i) => `<button class="chapter-card" data-chapter="${i}"><img src="${assetUrl(places.find(p => p.id === c.placeIds[0])?.image || '/images/hero.jpg')}" alt="" loading="lazy"><div></div><span class="chapter-number">${c.number}</span><span class="chapter-content"><small>${c.en}</small><strong>${c.title}</strong><p>${c.intro || c.description}</p><span>${c.placeIds.length} 站 · 约 ${Math.round(c.placeIds.length * 11 / 60)} 分钟 ${icon('arrow')}</span></span></button>`).join('')}</div>`;
  $('.story-dialog').querySelector('[data-close]').onclick = () => $('.story-dialog').close();
  $('.story-dialog').querySelectorAll('[data-chapter]').forEach(b => b.onclick = () => { $('.story-dialog').close(); startTour(chapters[Number(b.dataset.chapter)].placeIds); });
  $('.story-dialog').showModal();
}

async function openAbout(showSources = false) {
  const sourceLinks = [...new Map([...sources, ...places.map(p => p.source)].map(s => [s.url, s])).values()];
  $('.about-dialog').innerHTML = `<div class="dialog-top"><span>寰游 / ABOUT THIS ATLAS</span><button class="icon-button" data-close aria-label="关闭说明">${icon('close')}</button></div><div class="about-content"><div class="eyebrow">以地理的眼光，走近世界</div><h2 id="about-title">一颗地球，<br>万千种相遇。</h2><p>寰游是一部以三维地球为入口的全球地理与文明图鉴。首批收录六大洲 ${countryNames.length} 个国家的 ${places.length} 个代表坐标，以真实影像、地形、摄影与地点手记，连接自然成因、历史记忆和当代生活。原有中国 81 个地点与山系水系专题完整保留。</p><h3 id="data-notes">地图、覆盖与精度</h3><ul><li>全球地图：MapLibre GL JS 的球面投影，低倍观看地球，放大后探索地表。卫星影像为 Esri World Imagery，地形晕渲为 World Shaded Relief，来源包括 Esri、Vantor、Earthstar Geographics 及 GIS User Community；分辨率和拍摄日期因地区而异。</li><li>高程：Mapzen / AWS Terrain Tiles，Terrarium 编码。普通山地在近景加载真实 DEM，垂直起伏放大 1.5 倍便于观察。城市地点可采用平面背景以避免高程伪起伏；摄影实景保持模型原始尺度，背景地形按片区设置。</li><li>摄影实景：目前开放 ${realScenes.length} 个片区，只有实际取得并验收的范围才提供建筑摄影模型。金色虚线标示覆盖范围，范围外继续显示卫星影像。尚未取得模型的国外城市地标会在地点手记中明确说明。</li><li>各片区分别记录来源、坐标变换、模型范围、修订日与许可；修订日不等于拍摄日期，画面非实时。摄影重建可能有遮挡、树冠、边缘接缝和细节缺失，展示不作为测绘、导航或建筑工程依据。</li><li>地点坐标采用 WGS84，表示景观代表位置，并不等同于景区入口或照片拍摄机位。跨境山地与遗产的国家字段用于组织本批所选地点，不表示完整遗产范围或主权边界。</li><li>中国边界和省界沿用 DataV GeoAtlas，包含 34 个省级行政区。中国山系为 24 条手工概化走向，水系为 Natural Earth 1:1000万数据的 60 项代表性选择，均为区域认知图层，未延伸为全球完整山脊、河网或精确岸线。</li><li>低倍全球影像与部分目的地邻域随站点缓存；未缓存的高倍视野、平移区域及缩放级别仍需联网。全球景点为代表性策展，不承诺已收录全部国家、景点或全部地标的三维实景。</li></ul><h3>已开放实景与来源</h3><div class="reference-links">${realScenes.map(scene => `<a href="${scene.sourceUrl}" target="_blank" rel="noopener noreferrer">${safeText(scene.name)} · ${safeText(scene.attribution || '香港地政总署 / CSDI')} ${icon('arrow')}</a><a href="${scene.licenseUrl}" target="_blank" rel="noopener noreferrer">${safeText(scene.name)} · 使用条款 ${icon('arrow')}</a>`).join('')}</div><h3>延伸阅读与资料</h3><div class="reference-links">${sourceLinks.map(source => `<a href="${source.url}" target="_blank" rel="noopener noreferrer">${safeText(source.label || source.name || source.title)} ${icon('arrow')}</a>`).join('')}<a href="https://github.com/tilezen/joerd/blob/master/docs/attribution.md" target="_blank" rel="noopener noreferrer">地形数据来源与许可 ${icon('arrow')}</a><a href="${assetUrl('data/mountains.geojson')}" target="_blank" rel="noopener noreferrer">中国山系 · 概化走向与参考资料 ${icon('arrow')}</a><a href="${assetUrl('data/rivers.geojson')}" target="_blank" rel="noopener noreferrer">中国水系 · 数据来源与精度说明 ${icon('arrow')}</a></div><h3>摄影来源</h3><div class="photo-sources">正在读取摄影资料…</div><p class="about-footer">寰游 · ATLAS OF EARTH<br>独立地理与文明探索作品，原名「山河志」，与星球研究所无关联。</p></div>`;
  $('.about-dialog').querySelector('[data-close]').onclick = () => $('.about-dialog').close();
  $('.about-dialog').showModal();
  if (showSources) $('#data-notes').scrollIntoView({ block: 'start' });
  try {
    await loadPhotography();
    const entries = [...Object.values(photos), ...Object.values(detailPhotos)];
    $('.photo-sources').innerHTML = entries.map(s => `<div><a href="${s.sourceUrl || s.source || s.url || s.originalUrl || '#'}" target="_blank" rel="noopener noreferrer">${safeText(s.title || s.id || '')}</a><span>${safeText(s.attribution || s.author || s.credit || '')} · <a href="${s.licenseUrl || s.sourceUrl}" target="_blank" rel="noopener noreferrer">${safeText(s.license || '')}</a> · 经缩放与压缩</span></div>`).join('');
  } catch { $('.photo-sources').textContent = '摄影资料暂未载入，请稍后重试。'; }
}

function bindUI() {
  document.querySelectorAll('button[aria-label]').forEach(b => { b.title = b.getAttribute('aria-label'); });
  $('.brand').onclick = e => { e.preventDefault(); changeCategory('all'); changeScope('all'); };
  $('.main-nav').querySelectorAll('[data-category]').forEach(b => b.onclick = () => changeCategory(b.dataset.category));
  $('#explore-button').onclick = openCatalog;
  $('#intro-tour').onclick = () => startTour();
  $('#chapters-button').onclick = openChapters;
  $('#real-scenes-button').onclick = () => startRealScene();
  $('#real-scenes-button').onpointerenter = $('#real-scenes-button').onfocus = warmSceneRenderer;
  $('#scene-picker').onfocus = warmSceneRenderer;
  $('#scene-picker').onchange = e => startRealScene(realScenes.find(s => s.id === e.target.value));
  $('#scene-center').onclick = () => map?.flyTo({ ...sceneCamera(), duration: reducedMotion ? 0 : 1200 });
  $('#scene-close').onclick = closeRealScene;
  $('#catalog-button').onclick = openCatalog;
  $('#world-catalog-button').onclick = openCatalog;
  $('#discover-toggle').onclick = () => setDiscoveryOpen($('.discover').hidden);
  document.querySelectorAll('[data-continent]').forEach(button => button.onclick = () => changeScope(button.dataset.continent));
  $('#country-select').onchange = event => changeScope(state.continent, event.target.value);
  $('.search-toggle').onclick = openSearch;
  $('#search-input').oninput = e => renderSearch(e.target.value);
  $('#about-button').onclick = () => openAbout(); $('#sources-button').onclick = () => openAbout(true);
  document.querySelectorAll('dialog').forEach(dialog => { dialog.addEventListener('click', e => { if (e.target === dialog) { const b = dialog.getBoundingClientRect(); if (e.clientX < b.left || e.clientX > b.right || e.clientY < b.top || e.clientY > b.bottom) dialog.close(); } }); });
  $('.search-dialog [data-close]').onclick = () => $('.search-dialog').close();
  $('.photo-dialog [data-close]').onclick = () => $('.photo-dialog').close();
  $('#photo-prev').onclick = () => stepPhoto(-1); $('#photo-next').onclick = () => stepPhoto(1);
  $('.photo-dialog').addEventListener('keydown', e => { if (e.key === 'ArrowLeft' || e.key === 'ArrowRight') { e.preventDefault(); stepPhoto(e.key === 'ArrowLeft' ? -1 : 1); } });
  $('#cards-prev').onclick = () => $('#destination-track').scrollBy({ left: -470, behavior: reducedMotion ? 'instant' : 'smooth' });
  $('#cards-next').onclick = () => $('#destination-track').scrollBy({ left: 470, behavior: reducedMotion ? 'instant' : 'smooth' });
  $('#layers-button').onclick = () => { const picker = $('.layer-picker'); picker.hidden = !picker.hidden; if (!picker.hidden && state.mapReady) enhanceGeography(); $('#layers-button').classList.toggle('active', !picker.hidden); $('#layers-button').setAttribute('aria-expanded', String(!picker.hidden)); };
  $('#zoom-in').onclick = () => map?.zoomIn(); $('#zoom-out').onclick = () => map?.zoomOut();
  $('#north-button').onclick = () => map?.easeTo({ bearing: 0, duration: reducedMotion ? 0 : 700 });
  $('#home-button').onclick = () => changeScope('all');
  $('#terrain-button').onclick = () => { if (!state.mapReady || !currentView().available) return; state.terrain = !state.terrain; applyTerrain(); map.easeTo({ pitch: currentView().pitch, duration: reducedMotion ? 0 : 1000 }); };
  $('#fullscreen-button').onclick = async () => { try { if (document.fullscreenElement) await document.exitFullscreen(); else await document.documentElement.requestFullscreen(); } catch { showToast('当前浏览器暂不支持全屏模式'); } };
  document.addEventListener('fullscreenchange', () => { $('#fullscreen-button').setAttribute('aria-label', document.fullscreenElement ? '退出全屏' : '进入全屏'); map?.resize(); });
  $('.basemap-options').querySelectorAll('button').forEach(b => b.onclick = () => { if (!state.mapReady) return; state.layer = b.dataset.layer; map.setLayoutProperty('satellite', 'visibility', state.layer === 'satellite' ? 'visible' : 'none'); map.setLayoutProperty('relief', 'visibility', state.layer === 'relief' ? 'visible' : 'none'); $('.basemap-options').querySelectorAll('button').forEach(el => el.classList.toggle('active', el === b)); });
  $('#border-toggle').onchange = e => { state.borders = e.target.checked; applyBorders(); };
  $('#river-toggle').onchange = e => setLandformVisible('river', e.target.checked);
  $('#mountain-toggle').onchange = e => setLandformVisible('mountain', e.target.checked);
  $('.landform-legend').querySelectorAll('button').forEach(b => b.onclick = () => setLandformVisible(b.dataset.landformKind, b.getAttribute('aria-pressed') !== 'true'));
  $('#landform-select').onchange = e => selectLandform(landforms?.features.find(f => f.properties.id === e.target.value));
  $('#tour-close').onclick = stopTour; $('#tour-next').onclick = () => { clearTimeout(tourTimer); nextTour(); };
  $('#tour-pause').onclick = () => { if (state.tour) { clearTimeout(tourTimer); map?.stop(); state.tour = false; $('.tour-progress').classList.remove('running'); $('#tour-pause').innerHTML = icon('play'); $('#tour-pause').setAttribute('aria-label', '继续漫游'); } else { state.tour = true; tourStep(); } };
  document.addEventListener('keydown', e => { if (e.key === 'Escape' && !document.querySelector('dialog[open]')) { $('.layer-picker').hidden = true; $('#layers-button').setAttribute('aria-expanded', 'false'); if (state.selected || state.landform) resetView(); } if ((e.key === 'k' && (e.metaKey || e.ctrlKey)) || (e.key === '/' && !/INPUT|TEXTAREA|SELECT/.test(document.activeElement.tagName))) { e.preventDefault(); if (!$('.search-dialog').open) openSearch(); } });
  let resizeTimer;
  window.addEventListener('hashchange', () => { const id = location.hash.slice(1); const scene = realScenes.find(s => s.id === id); if (scene) startRealScene(scene); else if (places.some(p => p.id === id)) selectPlace(id); else if (!id) resetView(); });
  window.addEventListener('resize', () => {
    map?.resize();
    clearTimeout(resizeTimer);
    resizeTimer = setTimeout(() => {
      if (!state.mapReady) return;
      if (state.selected) { const p = places.find(p => p.id === state.selected); map.jumpTo(state.realScene ? sceneCamera() : { center: p.coordinate, padding: mapPadding() }); }
      else if (state.landform) { const feature = landforms.features.find(f => f.properties.id === state.landform); map.fitBounds(landformBounds(feature), { padding: mapPadding(), absolutePadding: true, maxZoom: 6.5, pitch: state.terrain ? 40 : 0, bearing: -8, duration: 0 }); }
      else focusScope();
    }, 120);
  });
}

function updateCardSelection() {
  $('#destination-track').querySelectorAll('[data-place]').forEach(b => b.classList.toggle('selected', b.dataset.place === state.selected));
}

function applyBorders() {
  if (!state.mapReady) return;
  if (state.borders && !provincesLoaded) {
    map.getSource('provinces').setData(assetUrl('/data/china-provinces.geojson'));
    provincesLoaded = true;
  }
  map.setLayoutProperty('provinces', 'visibility', state.borders ? 'visible' : 'none');
}

function placeCamera(p) {
  if (state.realScene) return sceneCamera();
  return { center: p.coordinate, zoom: p.zoom, pitch: terrainView(p, state.terrain).pitch, bearing: -18, padding: mapPadding() };
}

function currentView() {
  if (state.realScene) return { available: false, enabled: false, pitch: activeScene.pitch, label: sceneStatus === 'ready' ? '真实纹理 · 三维实景' : '卫星影像 · 实景加载中' };
  const view = terrainView(places.find(p => p.id === state.selected), state.terrain);
  if (!state.selected && !state.landform) view.label = '三维地球 · 真实影像';
  return view;
}

function readyMapStatus() {
  const view = currentView();
  if (state.realScene) return sceneStatus === 'ready' ? `${activeScene.name} · 自由探索` : '正在加载实景建筑与纹理…';
  if (!state.selected && !state.landform && (map?.getZoom() ?? 0) < 5.5) return '三维地球 · 自由探索';
  return !view.available ? '城市影像 · 自由探索' : view.enabled ? '真实地形 · 自由探索' : '真实影像 · 自由探索';
}

function applyTerrain() {
  const view = currentView();
  const button = $('#terrain-button');
  button.disabled = !view.available;
  button.classList.toggle('is-active', view.enabled);
  button.setAttribute('aria-pressed', String(view.enabled));
  button.setAttribute('aria-label', state.realScene ? '真实建筑模型，地表不使用夸张高程' : view.available ? '3D，切换三维地形' : '城市影像，当前地点使用平面地表');
  button.title = button.getAttribute('aria-label');
  button.querySelector('.dimension').textContent = view.available || state.realScene ? '3D' : '2D';
  $('#map-mode').textContent = view.label;
  if (!state.mapReady || !terrainReady) return;
  let terrainSource = 'terrain';
  if (state.realScene && activeScene.terrainSource) {
    terrainSource = `terrain-${activeScene.id}`;
    if (!map.getSource(terrainSource)) map.addSource(terrainSource, { ...activeScene.terrainSource, tiles: activeScene.terrainSource.tiles.map(assetUrl) });
  }
  const terrain = state.realScene && activeScene.terrain ? { source: terrainSource, exaggeration: 1 } : view.enabled && map.getZoom() >= 5.5 ? { source: 'terrain', exaggeration: 1.5 } : null;
  const currentTerrain = map.getTerrain();
  if (currentTerrain?.source !== terrain?.source || currentTerrain?.exaggeration !== terrain?.exaggeration) map.setTerrain(terrain);
  map.setLayoutProperty('hillshade', 'visibility', terrain && !state.realScene ? 'visible' : 'none');
  $('#map-status').textContent = readyMapStatus();
}

function overviewCamera() {
  const wide = innerWidth > 700;
  return { center: [30, 22], zoom: wide ? 2.15 + Math.log2(innerHeight / 900) : 1.05 + Math.log2(innerWidth / 390), padding: wide ? { left: 80, right: 80, top: 100, bottom: 75 } : { left: 5, right: 5, top: 140, bottom: 65 }, pitch: 0, bearing: 0 };
}

async function initMap() {
  try {
    // Deep links fetch their neighborhood while the engine is still starting.
    const linkedId = state.selected || location.hash.slice(1);
    if (places.some(p => p.id === linkedId)) loadTileCoverage();
    maplibregl = await mapEngine;
    installTileProtocol(maplibregl, { baseURL: new URL(import.meta.env.BASE_URL, location.href).href, detailCoverageReady: loadTileCoverage });
    const linkedPlace = places.find(p => p.id === (state.selected || location.hash.slice(1)));
    if (linkedPlace && !state.selected) { state.selected = linkedPlace.id; renderPlace(linkedPlace); updateCardSelection(); }
    // Close-up background tiles wait in the protocol; map and model startup can proceed.
    const initialPlace = places.find(p => p.id === state.selected);
    const initialScene = state.realScene;
    const camera = initialPlace ? placeCamera(initialPlace) : overviewCamera();
    map = new maplibregl.Map({ container: 'map', ...camera, centerClampedToGround: !state.realScene, maxPitch: 75, minZoom: .5, maxZoom: state.realScene ? 19 : 18, maxTileCacheSize: 256, maxCanvasSize: [8192, 8192], fadeDuration: 0, renderWorldCopies: false, attributionControl: false, canvasContextAttributes: { antialias: true }, style: { version: 8, projection: state.realScene ? { type: 'mercator' } : worldProjection, sources: {
      satellite: { type: 'raster', tiles: ['atlas://satellite/{z}/{x}/{y}'], tileSize: 256, maxzoom: 18, attribution: '© Esri, Vantor, Earthstar Geographics' },
      relief: { type: 'raster', tiles: ['atlas://relief/{z}/{x}/{y}'], tileSize: 256, maxzoom: 13, attribution: '© Esri, USGS, NOAA' },
      terrain: { type: 'raster-dem', tiles: ['atlas://terrain/{z}/{x}/{y}'], tileSize: 256, encoding: 'terrarium', maxzoom: 14, attribution: '© Mapzen, USGS, NASA' },
      'hillshade-terrain': { type: 'raster-dem', tiles: ['atlas://terrain/{z}/{x}/{y}'], tileSize: 256, encoding: 'terrarium', maxzoom: 14 },
      outline: { type: 'geojson', data: { type: 'FeatureCollection', features: [] } },
      provinces: { type: 'geojson', data: { type: 'FeatureCollection', features: [] } }
    }, layers: [
      { id: 'background', type: 'background', paint: { 'background-color': '#13272e' } },
      { id: 'satellite', type: 'raster', source: 'satellite', paint: { 'raster-saturation': -.25, 'raster-contrast': .12, 'raster-brightness-max': .84, 'raster-fade-duration': 0 } },
      { id: 'relief', type: 'raster', source: 'relief', layout: { visibility: 'none' }, paint: { 'raster-saturation': -.32, 'raster-brightness-max': .75 } },
      { id: 'hillshade', type: 'hillshade', source: 'hillshade-terrain', layout: { visibility: 'none' }, paint: { 'hillshade-exaggeration': .24, 'hillshade-shadow-color': '#10252e', 'hillshade-highlight-color': '#d6debb', 'hillshade-illumination-direction': 315 } },
      { id: 'country-glow', type: 'line', source: 'outline', minzoom: 4, maxzoom: 10, paint: { 'line-color': '#e0d6ab', 'line-width': 5, 'line-opacity': .10, 'line-blur': 5 } },
      { id: 'country-outline', type: 'line', source: 'outline', minzoom: 4, maxzoom: 10, paint: { 'line-color': '#e1d5b3', 'line-width': 1, 'line-opacity': ['interpolate', ['linear'], ['zoom'], 5, .62, 9, .2, 10, 0] } },
      { id: 'provinces', type: 'line', source: 'provinces', maxzoom: 10, layout: { visibility: 'none' }, paint: { 'line-color': '#eee5c9', 'line-width': .65, 'line-opacity': .42 } }
    ], sky: { 'sky-color': '#081725', 'horizon-color': '#8ca5b8', 'fog-color': '#182e3d', 'fog-ground-blend': .25, 'horizon-fog-blend': .6, 'sky-horizon-blend': .8, 'atmosphere-blend': ['interpolate', ['linear'], ['zoom'], 0, .75, 5, .75, 8, 0] } } });
    map.addControl(new maplibregl.ScaleControl({ maxWidth: 95, unit: 'metric' }), 'bottom-right');
    map.once('style.load', () => {
      state.mapReady = true;
      map.setMaxZoom(state.realScene ? 19 : 18);
      map.setCenterClampedToGround(!state.realScene);
      performance.mark('atlas-interactive');
      $('#map-status').textContent = '影像载入中 · 已可探索';
      const currentPlace = places.find(p => p.id === state.selected);
      if (currentPlace?.id !== initialPlace?.id || state.realScene || initialScene) map.jumpTo(currentPlace ? placeCamera(currentPlace) : overviewCamera());
      if (!currentPlace && !state.realScene && (state.continent !== 'all' || state.country !== 'all')) focusScope();
      if (currentPlace) $('.map-caption').innerHTML = `<span class="live-dot"></span> ${state.realScene ? activeScene.name : currentPlace.name} <span class="caption-divider">/</span><span id="map-mode">${currentView().label}</span>`;
      applyTerrain();
      applyBorders();
      if (state.realScene) activateRealScene();
      addMarkers();
      window.__atlas = { map, state, places, realScenes, selectPlace, startRealScene, startTour, stopTour, resetView, changeScope, setDiscoveryOpen, selectLandform, setLandformVisible, get landforms() { return landforms; } };
    });
    let enhanced = false;
    const enhanceMap = () => {
      if (enhanced) return;
      enhanced = true;
      map.off('sourcedata', onImagery);
      performance.mark('atlas-imagery');
      // Paint the satellite view first; DEM and thematic labels enhance it afterwards.
      terrainReady = true;
      applyTerrain();
      $('#map-status').textContent = currentView().enabled ? '影像已就绪 · 地形细化中' : readyMapStatus();
      enhanceRegion();
      map.once('idle', () => {
        performance.mark('atlas-ready');
        if (!errorNotice) $('#map-status').textContent = readyMapStatus();
      });
    };
    const onImagery = e => { if (e.sourceId === state.layer && e.sourceDataType === 'content' && e.tile) enhanceMap(); };
    map.on('sourcedata', onImagery);
    map.once('load', enhanceMap);
    map.on('move', scheduleMarkers);
    map.on('moveend', scheduleMarkers);
    map.on('moveend', () => {
      applyTerrain();
      enhanceRegion();
      if (state.realScene && (map.getZoom() < 12 || !map.getBounds().intersects([[activeScene.bounds[0], activeScene.bounds[1]], [activeScene.bounds[2], activeScene.bounds[3]]]))) closeRealScene();
    });
    map.on('resize', scheduleMarkers);
    map.on('idle', scheduleMarkers);
    let errorNotice = false;
    map.on('error', e => { console.warn('Map resource:', e.error?.message || e); if (e.sourceId === 'provinces') provincesLoaded = false; if (state.mapReady && !errorNotice && /fetch|network|tile/i.test(e.error?.message || '')) { errorNotice = true; $('#map-status').textContent = '部分高清影像暂不可用 · 可返回全景'; } });
  } catch (error) { console.error(error); $('#map-status').textContent = '浏览器暂不支持三维地图'; showToast('请使用支持 WebGL 的现代浏览器，浏览三维地球'); }
}

function addMarkers() {
  updatePlaceMarkers = addPlaceMarkers(map, places, highlights, selectPlace);
  updatePlaceMarkers(state);
  scheduleMarkers();
}

function scheduleMarkers() {
  if (!map || markerFrame || markerTimer) return;
  // MapLibre animates labels; coordinates and compass update at most every 80 ms.
  markerTimer = setTimeout(() => {
    markerTimer = null;
    markerFrame = requestAnimationFrame(() => { markerFrame = null; lastMarkerUpdate = performance.now(); updateMarkers(); });
  }, Math.max(0, 80 - (performance.now() - lastMarkerUpdate)));
}

function updateMarkers() {
  const c = map.getCenter();
  $('#coordinates').textContent = `${Math.abs(c.lng).toFixed(2)}° ${c.lng >= 0 ? 'E' : 'W'}　 ${Math.abs(c.lat).toFixed(2)}° ${c.lat >= 0 ? 'N' : 'S'}`;
  $('.compass-button .icon').style.transform = `rotate(${-map.getBearing()}deg)`;
  $('.atlas').classList.toggle('regional-geography', map.getZoom() >= 3.3 && c.lng > 65 && c.lng < 145 && c.lat > 5 && c.lat < 60 && !state.realScene);
  updatePlaceMarkers?.(state);
}

updateScopeUI(); renderCards(); bindUI();
const initialScene = realScenes.find(s => s.id === location.hash.slice(1));
if (initialScene) { warmSceneRenderer(); startRealScene(initialScene); }
performance.mark('atlas-shell');
initMap();
function loadPhotography() {
  photographyReady ??= Promise.all(['./data/photo-sources.json', './data/detail-photos-nature.json', './data/detail-photos-culture.json', './data/photo-sources-world.json', './data/detail-photos-world.json'].map(url => fetch(assetUrl(url), { priority: 'low' }).then(r => { if (!r.ok) throw new Error('Photography metadata unavailable'); return r.json(); }))).then(([covers, nature, culture, world, worldDetails]) => {
    photos = { ...covers, ...world };
    detailPhotos = Object.fromEntries([...nature, ...culture, ...worldDetails].map(p => [p.id, p]));
    if (state.selected) renderPlace(places.find(p => p.id === state.selected), true);
    if ($('.photo-dialog').open) renderPhoto();
  });
  photographyReady.catch(() => { photographyReady = null; });
  return photographyReady;
}
