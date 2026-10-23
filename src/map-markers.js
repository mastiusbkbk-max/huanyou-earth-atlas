// Projection, globe occlusion and label collisions share the map's GPU layers.
export function addPlaceMarkers(map, places, highlights, onSelect) {
  const font = ['PingFang SC', 'Microsoft YaHei', 'sans-serif'];
  const point = (id, name, coordinate, properties = {}) => ({ type: 'Feature', properties: { id, name, ...properties }, geometry: { type: 'Point', coordinates: coordinate } });
  map.addSource('places', { type: 'geojson', data: {
    type: 'FeatureCollection', features: places.map((p, i) => point(p.id, p.name, p.coordinate, {
      category: p.category, continent: p.continent, country: p.country,
      priority: highlights.includes(p.id) ? highlights.indexOf(p.id) : 20 + i
    }))
  } });
  const pixels = new Uint8Array(32 * 32 * 4);
  for (let y = 0; y < 32; y++) for (let x = 0; x < 32; x++) {
    const alpha = Math.max(0, Math.min(1, 6.5 - Math.hypot(x - 15.5, y - 15.5)));
    pixels.set([255, 234, 200, Math.round(alpha * 255)], (y * 32 + x) * 4);
  }
  map.addImage('place-dot', { width: 32, height: 32, data: pixels }, { pixelRatio: 2 });
  for (const [id, active] of [['place-labels', false], ['place-selected', true]]) {
    map.addLayer({ id, type: 'symbol', source: 'places', ...(active ? { filter: ['==', ['get', 'id'], ''] } : {}), layout: {
      'symbol-sort-key': ['get', 'priority'],
      'icon-image': 'place-dot', 'icon-size': active ? .95 : .65,
      'icon-padding': 5, 'icon-allow-overlap': active,
      'text-field': ['get', 'name'], 'text-font': font,
      'text-size': active ? 13 : 11, 'text-anchor': 'left', 'text-offset': [.85, 0],
      'text-padding': 12, 'text-max-width': 18, 'text-allow-overlap': active,
      'text-pitch-alignment': 'viewport', 'icon-pitch-alignment': 'viewport'
    }, paint: {
      'text-color': active ? '#ffe2ae' : ['match', ['get', 'category'], 'culture', '#e5c2a5', '#c5d7c3'],
      'text-halo-color': '#071925', 'text-halo-width': 1.5,
      'icon-opacity': active ? 1 : .85
    } });
    map.on('click', id, event => {
      event.preventDefault();
      if (event.features?.[0]) onSelect(event.features[0].properties.id);
    });
    map.on('mouseenter', id, () => { map.getCanvas().style.cursor = 'pointer'; });
    map.on('mouseleave', id, () => { map.getCanvas().style.cursor = ''; });
  }
  const labels = [ ['青 藏 高 原', 87, 33], ['塔 里 木 盆 地', 82.5, 39], ['内 蒙 古 高 原', 111, 44], ['东 北 平 原', 126, 47], ['华 北 平 原', 116, 36], ['四 川 盆 地', 105.2, 30.8], ['南 海', 118.5, 18], ['台 湾 岛', 121, 23.7], ['海 南 岛', 109.5, 19.2] ];
  map.addSource('geography-names', { type: 'geojson', data: { type: 'FeatureCollection', features: labels.map(([name, x, y], i) => point(String(i), name, [x, y])) } });
  map.addLayer({ id: 'geography-names', type: 'symbol', source: 'geography-names', minzoom: 3.3, maxzoom: 8.5,
    layout: { 'text-field': ['get', 'name'], 'text-font': font, 'text-size': 12, 'text-padding': 20 },
    paint: { 'text-color': '#b4c3ae', 'text-opacity': .5, 'text-halo-color': '#10262b', 'text-halo-width': 1 }
  });
  let previous;
  return state => {
    const key = [state.category, state.continent, state.country, state.selected, state.realScene].join('|');
    if (key === previous) return;
    previous = key;
    const filter = ['all', ['!=', ['get', 'id'], state.selected || '']];
    for (const property of ['category', 'continent', 'country']) if (state[property] !== 'all') filter.push(['==', ['get', property], state[property]]);
    map.setFilter('place-labels', filter);
    map.setFilter('place-selected', ['==', ['get', 'id'], state.selected || '']);
    for (const id of ['place-labels', 'place-selected', 'geography-names']) map.setLayoutProperty(id, 'visibility', state.realScene ? 'none' : 'visible');
  };
}
