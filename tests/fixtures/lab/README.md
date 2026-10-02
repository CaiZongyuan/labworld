# GLB Browser Fixtures

`cube.glb` is a one-meter indexed box. `mixed.glb` combines that box with line and point primitives. They are generated test geometry, contain no external resources or copyrighted model textures, and exercise camera framing and resource lifetime. Generation uses Three.js BoxGeometry and glTF Transform's structured document API; the browser imports the files through the public file input.

`cube-draco.glb` and `cube-meshopt.glb` were generated from `cube.glb` with
glTF Transform CLI 4.5.1 (`draco` and `meshopt` commands). They exercise real
compressed geometry, including Meshopt's fallback buffer and quantization.

`cube-basis.glb` adds a KTX2 texture through NodeIO and KHRTextureBasisu from
glTF Transform 4.5.1. The texture is Three.js's MIT-licensed
[2d_uastc.ktx2](https://github.com/mrdoob/three.js/blob/dev/examples/textures/ktx2/2d_uastc.ktx2),
downloaded on 2026-10-03, SHA-256
`21b6912cae1f074ae3eda1b751f43c36eafc7eb83f3af71f85bba2ccbafce125`.
The fixture tests embedded Basis texture decoding without a fallback PNG.
