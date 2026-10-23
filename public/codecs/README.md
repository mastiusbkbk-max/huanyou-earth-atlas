# Local scene decoders

Unmodified runtime libraries bundled with `@loaders.gl/draco@4.4.3` and
`@loaders.gl/textures@4.4.3` (`src/libs/` in the installed packages).
Loaded only for the Peak's Draco geometry and Basis/KTX2 photography.

- Google Draco: `draco_wasm_wrapper.js`, `draco_decoder.wasm`.
  Source: https://github.com/google/draco · license: `DRACO-LICENSE.txt`.
- Binomial Basis Universal: `basis_encoder.js`, `basis_encoder.wasm`.
  Source: https://github.com/BinomialLLC/basis_universal · license: `BASIS-LICENSE.txt`.

The application adapts decoded Float64 texture coordinates to Float32 in memory
for loaders.gl compatibility. These library files and the official B3DM files
are not modified.
