import workerUrl from 'maplibre-gl/dist/maplibre-gl-worker.mjs?url';

// Start the engine and its workers while the editorial application downloads.
export const mapEngine = import('maplibre-gl').then(engine => {
  engine.setWorkerUrl(workerUrl);
  engine.setWorkerCount(navigator.hardwareConcurrency >= 4 ? 2 : 1);
  engine.prewarm();
  return engine;
});
