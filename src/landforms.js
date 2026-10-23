// Overview geography stays draped over the same terrain as the imagery.
export const landformLabelLayers = [];

function riverLabelPoint(feature) {
  const lines = feature.geometry.type === 'LineString' ? [feature.geometry.coordinates] : feature.geometry.coordinates;
  const distance = (a, b) => Math.hypot((b[0] - a[0]) * Math.cos(a[1] * Math.PI / 180), b[1] - a[1]);
  const lengths = lines.map(line => line.slice(1).reduce((sum, p, i) => sum + distance(line[i], p), 0));
  const index = lengths.indexOf(Math.max(...lengths));
  const line = lines[index];
  let remaining = lengths[index] / 2;
  for (let i = 1; i < line.length; i++) {
    remaining -= distance(line[i - 1], line[i]);
    if (remaining <= 0) return line[i];
  }
  return line[0];
}

export function loadLandformData() {
  return Promise.all(['mountains', 'rivers'].map(async name => {
    const response = await fetch(`${import.meta.env.BASE_URL}data/${name}.geojson`, { priority: 'low' });
    if (!response.ok) throw new Error(`Unable to load ${name}`);
    return response.json();
  }));
}

export async function addLandforms(map, onSelect, collections) {
  collections = await (collections ?? loadLandformData());
  const features = collections.flatMap(data => data.features);
  const names = features.map(f => f.properties.name).join('');
  const fontReady = document.fonts.load('600 16px "Noto Serif SC"', names).catch(() => {});
  const layerIds = { mountain: [], river: [] };
  const colors = { mountain: '#dec28a', river: '#86d8e7' };
  const riverColor = ['case', ['==', ['get', 'name'], '黄河'], '#edc477', colors.river];
  const fade = opacity => ['interpolate', ['linear'], ['zoom'], 7.3, opacity, 8.5, 0];

  for (const [index, kind] of ['mountain', 'river'].entries()) {
    map.addSource(kind, { type: 'geojson', data: collections[index], tolerance: .25 });
    for (const tier of [1, 2, 3]) {
      const minzoom = tier === 1 ? 3.3 : tier === 2 ? (kind === 'mountain' ? 3.3 : 4) : 4.7;
      const common = { source: kind, minzoom, maxzoom: 8.5, filter: ['==', ['get', 'tier'], tier] };
      const lineLayout = { 'line-cap': 'round', 'line-join': 'round' };
      const haloId = `${kind}-halo-${tier}`;
      const lineId = `${kind}-line-${tier}`;
      map.addLayer({ ...common, id: haloId, type: 'line', layout: lineLayout, paint: {
        'line-color': '#082731',
        'line-width': ['interpolate', ['linear'], ['zoom'], 3, 5, 7, 7],
        'line-blur': 1,
        'line-opacity': fade(kind === 'mountain' ? .65 : .8)
      } });
      map.addLayer({ ...common, id: lineId, type: 'line', layout: lineLayout, paint: {
        'line-color': kind === 'mountain' ? colors.mountain : riverColor,
        'line-width': ['interpolate', ['linear'], ['zoom'], 3, kind === 'mountain' ? 1.8 : (tier === 1 ? 2 : 1.3), 7, kind === 'mountain' ? 2.2 : 3],
        'line-opacity': fade(kind === 'mountain' ? .88 : .92),
        ...(kind === 'mountain' ? { 'line-dasharray': [3, 2] } : {})
      } });
      layerIds[kind].push(haloId, lineId);
    }
  }
  map.addSource('landform-selected', { type: 'geojson', data: { type: 'FeatureCollection', features: [] } });
  map.addLayer({ id: 'landform-selected-halo', type: 'line', source: 'landform-selected', maxzoom: 8.5, layout: { 'line-cap': 'round', 'line-join': 'round' }, paint: { 'line-color': '#f4edce', 'line-width': 9, 'line-blur': 5, 'line-opacity': .55 } });
  map.addLayer({ id: 'landform-selected-line', type: 'line', source: 'landform-selected', maxzoom: 8.5, layout: { 'line-cap': 'round', 'line-join': 'round' }, paint: { 'line-color': ['match', ['get', 'kind'], 'mountain', '#ffe0a1', riverColor], 'line-width': 3, 'line-opacity': fade(1) } });
  // At country scale, river meanders are too tight for legible curved text.
  // Pin a horizontal name to an actual vertex, then use along-river text up close.
  map.addSource('river-label-points', { type: 'geojson', data: { type: 'FeatureCollection', features: collections[1].features.map(f => ({ type: 'Feature', properties: f.properties, geometry: { type: 'Point', coordinates: riverLabelPoint(f) } })) } });
  map.addSource('mountain-label-points', { type: 'geojson', data: { type: 'FeatureCollection', features: collections[0].features.map(f => ({ type: 'Feature', properties: f.properties, geometry: { type: 'Point', coordinates: f.properties.label_coord } })) } });

  // Lines can be explored while the optional label font is still loading.
  await Promise.race([fontReady, new Promise(resolve => setTimeout(resolve, 2500))]);
  for (const kind of ['mountain', 'river']) {
    for (const tier of [1, 2, 3]) {
      const id = `${kind}-labels-${tier}`;
      const minzoom = tier === 1 ? 3.3 : tier === 2 ? (kind === 'mountain' ? 3.3 : 4) : 4.7;
      const overviewMax = kind === 'mountain' ? 4.3 : 5.5;
      map.addLayer({ id, type: 'symbol', source: kind, minzoom: Math.max(minzoom, overviewMax), maxzoom: 8.5,
        filter: ['==', ['get', 'tier'], tier], layout: {
          'symbol-placement': 'line', 'symbol-spacing': kind === 'mountain' ? 430 : 350,
          'text-field': ['get', 'name'], 'text-font': ['Noto Serif SC', 'Songti SC', 'SimSun', 'serif'],
          'text-size': ['interpolate', ['linear'], ['zoom'], 3, kind === 'mountain' ? 12 : 11, 6, kind === 'mountain' ? 15 : 13],
          'text-letter-spacing': kind === 'mountain' ? .24 : .12,
          'text-max-angle': 55, 'text-padding': 9, 'text-keep-upright': true,
          'text-pitch-alignment': 'viewport', 'text-rotation-alignment': 'map',
          'text-offset': [0, kind === 'mountain' ? -.8 : -.65]
        }, paint: { 'text-color': kind === 'mountain' ? '#f0d6a2' : riverColor, 'text-halo-color': '#10262b', 'text-halo-width': 1.8, 'text-halo-blur': .7, 'text-opacity': fade(1) }
      });
      layerIds[kind].push(id);
      landformLabelLayers.push(id);
      if (minzoom < overviewMax) {
        const pointId = `${kind}-overview-labels-${tier}`;
        map.addLayer({ id: pointId, type: 'symbol', source: `${kind}-label-points`, minzoom, maxzoom: overviewMax, filter: ['==', ['get', 'tier'], tier], layout: {
          'text-field': ['get', 'name'], 'text-font': ['Noto Serif SC', 'Songti SC', 'SimSun', 'serif'],
          'text-size': ['interpolate', ['linear'], ['zoom'], 3, kind === 'mountain' ? 12 : 11.5, 5, 13],
          'text-letter-spacing': kind === 'mountain' ? .24 : .15,
          'text-variable-anchor': ['bottom', 'top', 'left', 'right'], 'text-radial-offset': .65, 'text-padding': 4,
          'text-rotate': kind === 'mountain' ? ['get', 'label_angle'] : 0,
          'text-rotation-alignment': kind === 'mountain' ? 'map' : 'viewport', 'text-pitch-alignment': 'viewport'
        }, paint: { 'text-color': kind === 'mountain' ? '#f0d6a2' : riverColor, 'text-halo-color': '#10262b', 'text-halo-width': 1.8, 'text-halo-blur': .7 } });
        layerIds[kind].push(pointId); landformLabelLayers.push(pointId);
      }
    }
  }

  const hitLayers = [...landformLabelLayers, ...Object.values(layerIds).flat().filter(id => id.includes('-line-'))];
  const hoverLayers = [...hitLayers, ...['place-labels', 'place-selected'].filter(id => map.getLayer(id))];
  const hitAt = (point, layers = hitLayers) => map.queryRenderedFeatures([[point.x - 5, point.y - 5], [point.x + 5, point.y + 5]], { layers })
    .find(f => (f.layer.paint['text-opacity'] ?? f.layer.paint['line-opacity'] ?? 1) > .08);
  map.on('click', e => {
    if (e.defaultPrevented) return;
    const hit = hitAt(e.point);
    if (hit) onSelect(features.find(f => f.properties.id === hit.properties.id));
  });
  let hoverFrame;
  let hoverPoint;
  map.on('mousemove', e => {
    hoverPoint = e.point;
    if (hoverFrame || map.isMoving()) return;
    hoverFrame = requestAnimationFrame(() => {
      hoverFrame = null;
      map.getCanvas().style.cursor = hitAt(hoverPoint, hoverLayers) ? 'pointer' : '';
    });
  });
  let selected = null;
  return {
    features,
    setVisible(kind, visible) {
      layerIds[kind].forEach(id => map.setLayoutProperty(id, 'visibility', visible ? 'visible' : 'none'));
      if (selected?.properties.kind === kind) ['landform-selected-halo', 'landform-selected-line'].forEach(id => map.setLayoutProperty(id, 'visibility', visible ? 'visible' : 'none'));
    },
    select(feature) { selected = feature; map.getSource('landform-selected').setData(feature); ['landform-selected-halo', 'landform-selected-line'].forEach(id => map.setLayoutProperty(id, 'visibility', 'visible')); },
    clear() { selected = null; map.getSource('landform-selected').setData({ type: 'FeatureCollection', features: [] }); }
  };
}

export function landformBounds(feature) {
  const lines = feature.geometry.type === 'LineString' ? [feature.geometry.coordinates] : feature.geometry.coordinates;
  return lines.flat().reduce((bounds, point) => [
    [Math.min(bounds[0][0], point[0]), Math.min(bounds[0][1], point[1])],
    [Math.max(bounds[1][0], point[0]), Math.max(bounds[1][1], point[1])]
  ], [[180, 90], [-180, -90]]);
}
