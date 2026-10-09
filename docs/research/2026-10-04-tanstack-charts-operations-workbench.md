# TanStack Charts for the operations workbench

Access date: 2026-10-04. Maintainer research for the accepted Lab Word operations-workbench experience; this is not a public documentation route or a completed integration. Sources are official TanStack documentation, release source, npm metadata, and the official React/Vite documentation. TanStack source links below are fixed to release commit `e6a51a836e0bf9ea5288822a4247a995f43a768c` (`v1.0.0`).

## Package and release

| Verified fact                                                                                                                                                                                                                | Primary source                                                                |
| ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------- |
| Install package `@tanstack/charts`; new React code imports `Chart` from `@tanstack/charts/react`.                                                                                                                            | [React quick start][react-start], [installation][installation]                |
| npm `latest` is `1.0.0`, published 2026-10-03 at 15:09:37.619 UTC. GitHub published `v1.0.0` at 15:16:04 UTC with `prerelease: false`.                                                                                       | [npm metadata][npm], [release][release]                                       |
| `@tanstack/react-charts@1.0.0` remains a supported compatibility package for existing applications; its README directs new applications to `@tanstack/charts/react`.                                                         | [compatibility package README][legacy-readme], [its npm metadata][legacy-npm] |
| The package is MIT licensed. Distribution must retain the copyright and permission notice.                                                                                                                                   | [license][license]                                                            |
| The 1.0 contract covers documented APIs, defaults, framework support and optional import boundaries. The online `latest` docs say they follow unreleased `main`; use release-source docs when implementing a pinned version. | [compatibility contract][compatibility], [overview][overview]                 |

The stable release is one day old at this access date. The stability contract is verified; sustained production experience in Lab Word is not.

## Fit with the current toolchain

Lab Word currently declares React/React DOM `19.3.0`, Vite `8.3.1`, TypeScript `5.9.3`, and Node `24.18.0` in [the root package manifest](../../package.json). These are the project declarations, not a claim that this research executed the tools.

| Tool               | Evidence and limit                                                                                                                                                                                                                                                                                                                                                                       |
| ------------------ | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| React `19.3.0`     | Published React and React DOM peer ranges are `^18.0.0 \|\| ^19.0.0`, so the declared project version fits. Framework peers are optional at package level because they belong to separate adapter subpaths. [npm][npm], [installation][installation] |
| Vite `8.3.1`       | Published package exports ESM JavaScript and declarations and sets `sideEffects: false`; the release workspace declares Vite `^8.0.16`. This supports the expected bundling approach but does not verify this app's exact Vite build. [npm][npm], [upstream workspace manifest][workspace], [bundle guide][bundle]                                                                       |
| TypeScript `5.9.3` | Charts ships declarations and inference from chart definitions. No minimum TypeScript version is declared in the published metadata; the release workspace declares TypeScript `^6.0.0`. Compatibility with this project's 5.9 compiler remains unverified and must be checked against the installed published package. [npm][npm], [installation][installation], [workspace][workspace] |
| Node `24.18.0`     | npm metadata records publication using Node `24.18.0`; the upstream workspace requires Node `>=22`. The published package has no `engines` field. These facts are not an exact-runtime integration test. [npm][npm], [workspace][workspace]                                                                                                                                              |

DOM mounting uses normal DOM APIs and `ResizeObserver` for responsive sizing. Browser-free scene creation and SVG serialization are supported. Canvas additionally requires Canvas 2D and, for curved paths, `Path2D`. [Installation][installation]

## Time series, gaps and tooltips

- `lineY` maps numeric y values against numeric, categorical or temporal x values. It groups paths by `z` (or by `color` when `z` is absent), preserves input order, and emits one interaction point per valid row. Sort rows by the timestamp used for the displayed x axis before constructing the mark. [Line reference][line-doc]
- A real elapsed-time axis uses `scaleUtc` or `scaleTime` from `d3-scale`; compact band/point scales treat `Date` values as categories and do not preserve elapsed-time distances. Application code importing `d3-scale` must declare `d3-scale` and `@types/d3-scale` directly even though Charts also has a transitive D3 dependency. The release uses `d3-scale@4.0.2`. [Scales][scales], [package manifest][package]
- Null, undefined, invalid or nonfinite required positional values split paths. The released `line.ts` flushes the current segment and omits the invalid row from interaction points. It then appends every later valid row to the next segment. [Line reference][line-doc], [line source][line-source]
- A timestamp that is absent from the input does **not** create a gap. There is no elapsed-time threshold in the line construction loop. Lab Word must define an outage/freshness rule and supply an explicit null-valued row in the same series, or split the series, when that rule requires a discontinuity. Preserve nulls during preparation; substituting zero or filtering them out changes the observed meaning. This is an application design conclusion from the released algorithm. [Line source][line-source]
- `points: true` draws a dot for each valid sample and is appropriate when a gap can leave an isolated sample. The default is `false`. [Line reference][line-doc]
- Built-in tooltips are opt-in via `tooltip` from `@tanstack/charts/tooltip`. Focus supports nearest point, nearest x/y and grouped x/y modes; grouped x is useful for values from several series at the same sample time. The default maximum focus distance is 48 scene pixels. Automatic content uses locale-aware numbers and UTC ISO dates, with formatting callbacks available for product units and time display. [Tooltip guide][tooltip]
- The basic React entry renders the native tooltip. React-composed content uses the separate `@tanstack/charts/react/tooltip` entry and `renderTooltipBody`. Pinned content supports dismissal; transient content is inert. A gap row has no interaction point, so the application must expose missing-data status and its reason outside the value tooltip. [React adapter][react-adapter], [line source][line-source]

Accepted workbench policy supplied for this research: plot receipt timestamps with `scaleUtc`, and preserve the actual source timestamp in the observation and tooltip. Split lines at source, Device Program Run and unit changes, as well as stale intervals. The application must supply those segments or explicit same-series null markers; TanStack cannot infer these domain boundaries from valid rows. The planned return limit of 1,000 trend points and 256 KiB bounds the integration workload; no library capacity or application performance result was measured here.

## Sizing, theme and accessibility

Omit `width` to follow container width. Set an explicit fixed `height` for the dense workbench chart; React also supports `aspectRatio`. Use `min-width: 0` on shrinking grid/flex children and keep automatic margins for axes and long labels. The React initial/server width defaults to 640; `initialWidth` can make that initial geometry deterministic. [Responsive guide][responsive], [React adapter][react-adapter]

Charts inherits `currentColor`, a transparent background and six `--ts-chart-1` through `--ts-chart-6` palette variables. Map these to existing application theme tokens or supply the partial chart `theme`; the library does not install a global application theme. [Theme guide][theme]

The adapter requires `ariaLabel`, accepts `ariaDescription`, enables keyboard focus by default, and supports the same datum callbacks for pointer and keyboard users. Built-in tooltips expose structured rows through a polite status region. The application still owns meaningful units/time range, redundant status encoding, contrast checks and an exact-value table or other alternative. Default SVG tween and optional motion respect reduced motion. These are library capabilities, not evidence that a composed Lab Word chart meets accessibility requirements. [Accessibility guide][accessibility], [React adapter][react-adapter]

## Bundle and implementation guidance

Use named imports and exact capability subpaths. Default React rendering is SVG; Canvas, richer React tooltip bodies, portal positioning, motion, zoom and other capabilities are optional imports. Keep the y scale on compact `@tanstack/charts/scales/linear`; upgrade only the temporal x scale to D3. Memoize definitions that capture live observations because a new definition identity rebuilds the scene. [Bundle guide][bundle], [React adapter][react-adapter]

TanStack's released benchmark lists a compact React line consumer at 31,742 gzip bytes versus 38,843 with D3 linear scales, with React and React DOM external. This is an upstream fixture measurement, not the size of the workbench time-series chart with tooltips. Measure the actual production feature and retained modules, including its temporal scale and interaction. [Bundle guide][bundle]

Recommended application boundary: dynamically import the chart feature when its workbench view/panel is needed, with a stable-size loading fallback. React supports `lazy(() => import(...))` with `Suspense`, and Vite optimizes dynamic-import chunks and their shared dependencies. Keep the feature out of eagerly imported shared barrels; confirm the emitted initial bundle. This is integration guidance, not a TanStack-specific automatic code-splitting guarantee. [React lazy][react-lazy], [Vite features][vite-features]

Before adoption, run a focused integration with the **published** `1.0.0` package: the repository's TypeScript 5.9 check and Vite production build; ascending UTC receipt timestamps with explicit gaps and isolated points; pointer/keyboard tooltips retaining both receipt and source timestamps; resizing at accepted workbench widths; light/dark contrast; loading/error/empty/missing-data states; and actual chunk sizes. Use the real application browser journey as the primary behavioral check, supplemented by public HTTP contract checks for bounded trend data. This research did not install dependencies, modify production manifests/lockfiles, run integration tests, or measure application bundle size.

[npm]: https://registry.npmjs.org/@tanstack%2Fcharts
[legacy-npm]: https://registry.npmjs.org/@tanstack%2Freact-charts
[release]: https://github.com/TanStack/charts/releases/tag/v1.0.0
[license]: https://github.com/TanStack/charts/blob/e6a51a836e0bf9ea5288822a4247a995f43a768c/LICENSE
[legacy-readme]: https://github.com/TanStack/charts/blob/e6a51a836e0bf9ea5288822a4247a995f43a768c/packages/react-charts/README.md
[package]: https://github.com/TanStack/charts/blob/e6a51a836e0bf9ea5288822a4247a995f43a768c/packages/charts-core/package.json
[workspace]: https://github.com/TanStack/charts/blob/e6a51a836e0bf9ea5288822a4247a995f43a768c/package.json
[overview]: https://github.com/TanStack/charts/blob/e6a51a836e0bf9ea5288822a4247a995f43a768c/docs/overview.md
[compatibility]: https://github.com/TanStack/charts/blob/e6a51a836e0bf9ea5288822a4247a995f43a768c/docs/compatibility.md
[installation]: https://github.com/TanStack/charts/blob/e6a51a836e0bf9ea5288822a4247a995f43a768c/docs/installation.md
[react-start]: https://github.com/TanStack/charts/blob/e6a51a836e0bf9ea5288822a4247a995f43a768c/docs/framework/react/quick-start.md
[react-adapter]: https://github.com/TanStack/charts/blob/e6a51a836e0bf9ea5288822a4247a995f43a768c/docs/framework/react/adapter.md
[line-doc]: https://github.com/TanStack/charts/blob/e6a51a836e0bf9ea5288822a4247a995f43a768c/docs/reference/marks/line-and-area.md
[line-source]: https://github.com/TanStack/charts/blob/e6a51a836e0bf9ea5288822a4247a995f43a768c/packages/charts-core/src/line.ts#L314
[scales]: https://github.com/TanStack/charts/blob/e6a51a836e0bf9ea5288822a4247a995f43a768c/docs/concepts/scales-and-d3.md
[tooltip]: https://github.com/TanStack/charts/blob/e6a51a836e0bf9ea5288822a4247a995f43a768c/docs/guides/tooltips-and-focus.md
[responsive]: https://github.com/TanStack/charts/blob/e6a51a836e0bf9ea5288822a4247a995f43a768c/docs/guides/responsive-charts.md
[theme]: https://github.com/TanStack/charts/blob/e6a51a836e0bf9ea5288822a4247a995f43a768c/docs/guides/themes-and-styling.md
[accessibility]: https://github.com/TanStack/charts/blob/e6a51a836e0bf9ea5288822a4247a995f43a768c/docs/guides/accessibility.md
[bundle]: https://github.com/TanStack/charts/blob/e6a51a836e0bf9ea5288822a4247a995f43a768c/docs/guides/bundle-size-and-performance.md
[react-lazy]: https://react.dev/reference/react/lazy
[vite-features]: https://vite.dev/guide/features.html#async-chunk-loading-optimization
