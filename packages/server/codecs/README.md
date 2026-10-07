# Server validation codecs

Codec read, initialization and unexpected native failures return availability errors. The next request creates a fresh codec instance after recovery. Native validation refusal remains a content error. Only an explicit permanent content refusal changes a pending upload to rejected.

A failed instance is marked invalid. Pending callers reject it before a native call. An older instance cannot discard a newer cache entry. Trapped instances are discarded without further native cleanup calls.

The Node service loads the checked-in WASM files. Installation and startup do not invoke Rust, Cargo, Docker or an external decoder process.

`validation/` contains a validation-only binding. Its locked dependencies are draco-core 2.2.1, image 0.25.10 and gltf 1.4.1. These versions match the retained GLB implementation. The artifact has no host imports. It returns validation results and does not export geometry or pixels to JavaScript.

The Draco ABI receives the decoded-attribute, point and face limits before decoding. Lab passes 268435456 bytes and 22369621 points/faces. The decoded-byte limit covers cumulative decoded attribute values. It does not bound total WASM memory, scratch allocations or process RSS. Images use the retained allocation limit and PNG/JPEG/WebP/GIF decoders. The glTF binding checks the retained structure, references, scene graph, buffer/accessor ranges and expanded-accessor limit. The Node adapter also decodes Meshopt, Draco, images and every Basis mip before publication.

`basis/` is the Apache-2.0 transcoder pair from Three.js 0.186.1, upstream tag `r186`. Both files match the existing browser pair and the published Three.js package byte for byte. The `.cjs` extension enables the unmodified CommonJS wrapper in Node. Wrapper SHA-256: `8478b5b6d6b74e7d3082b89f6417321d8d1dc0307f2b30d4484bb11b441696a1`. WASM SHA-256: `6cf17dc889352c42e9acf8897107978d127005fe3386c36a0e3845e27967630a`. The exact internal Basis compiler version is not claimed.

Meshopt uses the explicit `meshoptimizer` 1.1.1 decoder dependency. Its MIT license ships in the npm package. [third-party.json](validation/third-party.json) lists the embedded Rust dependencies, checksums and licenses. Their original notices are retained in [licenses](validation/licenses). The draco-core archive omits its root license; the included license comes from upstream commit `c6244f35ec1a3c22a69948b04907244e9b215981`.

The validation source and compiler tooling are preserved at the immutable
[`legacy-rust-final` tag](https://github.com/CaiZongyuan/labworld/tree/legacy-rust-final/packages/server/codecs/validation),
commit `2fef28c35afea44ae2018f0e4b6a3a18a96a2bf7`. Current install,
startup and build use the checked-in validation WASM. The third-party
manifest and original licenses remain with the artifact.

Verify retained codec content refusal, availability failures and recovery:

```bash
node --test --experimental-strip-types tests/server/lab-codec.test.ts
```
