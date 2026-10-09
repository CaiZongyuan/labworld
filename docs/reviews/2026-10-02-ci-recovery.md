# Main CI Recovery

The user reported failure after publishing the accepted Lab Viewer and Asset Library. The starting revision is `cc0c7c3f7c69499777feb28b862bedc25e946e1a`; [Actions run 36938688713](https://github.com/CaiZongyuan/labworld/actions/runs/36938688713) fails Rust formatting and times out on the desktop deep-link journey. The recovery was implemented in an isolated checkout, excluding the original workspace's concurrent device-domain documents.

## Causes and Corrections

- Rust and project-owned frontend/tooling files had formatting drift. Existing `cargo fmt` and Prettier restore the required format.
- The desktop protocol contained an underscore, which is invalid in the URL scheme grammar. Registration, parsing and real desktop fixtures now consistently use `labos-threejs://`; external-target rejection is retained.
- The Core Views barrel exported reference businesses, violating the existing boundary checker. Knowledge and Notes retain explicit package subpaths, and Knowledge's application adapters use its owned entry.
- The newly copied upstream decoders were scanned as authored JavaScript. Narrow lint/format exclusions preserve their published bytes and licenses, along with original source assets. Project-owned code remains checked.
- Full backend verification exposed API-key validation using the old prefix's total length and suffix offset. Issuance and authentication now share the current prefix, and parsing validates the 64-character hexadecimal random suffix. Scope, revocation, expiry and refusal to fall back to a Cookie remain enforced.
- The default frontend concurrency on the 20-core local host produced one timing failure (250 passing tests). The same suite with two workers passed all 251 tests; the configuration now uses that tested bound without changing assertions, timeouts, isolation or coverage.

## Simplification and Review

The repository simplification pass inspected the changed modules, public callers and gate configuration against the starting revision. Sharing the API-key prefix removes a demonstrated source of drift; explicit business entry points remove the Core dependency violation. No further abstraction or behavior-preserving cleanup was justified. Published third-party assets and the Lab renderer were unchanged.

Independent Standards and Spec reviews were refreshed after the API-key and concurrency repairs. Both reported no actionable code findings. The first Spec review identified incomplete full-gate acceptance at the API-key tests; that failure was resolved before publication.

## Local Verification

These checks cover the recovery's uncommitted source diff against the starting revision, before the final commit:

- `just check` passed, including Rust formatting/Clippy, Prettier, ESLint, TypeScript, contract drift, module boundaries, all tooling/backend/frontend tests, performance budgets, documentation checks and both application/documentation builds.
- Frontend: 251 passed, with four pre-existing skipped tests. Tooling: 54 passed.
- Real Electron `just desktop-smoke`: four passed, including the formerly failing deep-link navigation, downloads, failure recovery and appearance persistence.
- Focused API-key public HTTP suites: eight passed, covering issued-key use, scope/grant intersection, revocation/expiry and malformed bearer refusal with a valid Cookie present.
- `git diff --check` passed. The existing bundle budgets passed at 222.1 KiB initial gzip; no budget was raised.

Local command logs were retained under `/tmp/labworld-ci-fix.MZ1zAN-*.log`. The repository's first Pages configuration is operational setup; remote CI and publication results are checked after pushing the reviewed commit.
