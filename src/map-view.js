// Terrain grids can contain urban surface artefacts; flat city views use imagery alone.
export function terrainView(place, requested) {
  const available = place?.terrain !== false;
  return {
    available,
    enabled: requested && available,
    pitch: requested ? (place?.pitch ?? 38) : 0,
    label: available ? (requested ? '三维地形已开启' : '平面地图') : '城市影像 · 平面地表',
  };
}
