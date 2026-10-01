# Third-party notices

Third-party assets and identity rendering shipped in this repository. Each entry lists
the upstream project, the version, the license and the in-repo location.

## Material Icon Theme file icons

- **Source:** <https://github.com/PKief/vscode-material-icon-theme>
  (npm package `material-icon-theme`)
- **Version:** 5.38.1
- **License:** MIT — reproduced verbatim in
  [`packages/ui/src/assets/material-file-icons/LICENSE`](packages/ui/src/assets/material-file-icons/LICENSE)
- **Location:** `packages/ui/src/assets/material-file-icons/*.svg`
  (32-icon subset; each SVG carries a header comment naming its upstream
  file and this notice)
- **Consumed by:** `packages/ui/src/components/material-file-icon.tsx`
- **Upstream copyright:** Copyright (c) 2025 Material Extensions

The vendored `LICENSE` file is the unmodified upstream license text:

```text
The MIT License (MIT)
Copyright (c) 2025 Material Extensions

Permission is hereby granted, free of charge, to any person obtaining a copy of this software and associated documentation files (the "Software"), to deal in the Software without restriction, including without limitation the rights to use, copy, modify, merge, publish, distribute, sublicense, and/or sell copies of the Software, and to permit persons to whom the Software is furnished to do so, subject to the following conditions:

The above copyright notice and this permission notice shall be included in all copies or substantial portions of the Software.

THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY, FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM, OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE SOFTWARE.
```

## DiceBear identity artwork

- **Source:** <https://www.dicebear.com/>, `@dicebear/core` 10.7.0 and `@dicebear/styles` 10.6.0.
- **Tooling license:** MIT, Copyright (c) 2026 Florian Körner. The dependency retains its upstream license, and the full notice is included in the avatar picker.
- **Artwork license:** CC0 1.0, <https://creativecommons.org/publicdomain/zero/1.0/>.
- **Attribution:** Lorelei by Lisa Wischofsky; Marbles, Voxel Bot and Glass by DiceBear.
- **Consumed by:** `packages/views/src/shell/dicebear-image.tsx`; generated locally with a stable seed and no external avatar service.

## Tabler identity glyphs

- **Source:** <https://tabler.io/icons>, `@tabler/icons-react` 3.46.0.
- **License:** MIT, Copyright (c) Paweł Kuna. The dependency retains its upstream license; the shipped picker includes the notice.
- **Consumed by:** `packages/views/src/shell/entity-graphic.tsx`, using the reference project's 20-glyph inventory for configurable collection icons.
