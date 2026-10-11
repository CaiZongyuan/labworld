# Pinned Newton scene candidate

The registered profile is `sha256:f9fa824ae95e56098534ada5362c1dc22fa3827ff606c7e7329a586a6c576751`.
`representations/base.glb` retains the exact combined archive `sha256:b54a855c8080af87f7a70bdae0e60819858def8edb84b58d9edcd1377d2b904f`.
The original ten visual geometries, maker meshes/licenses, body inertias and control facts are preserved.
Eleven locally derived collision members and their notices/provenance are part of the exact archive allowlist in `supported-profile.json`.

Issue #73 remains in development. Actual compiled cloud coverage/support, native float bounds, contact/constraint budgets, loaded lift/held and Viewer/Recording acceptance are pending independent validation.
The previous 4daa profile and its failed physical evidence remain in the development handoff history; candidate registration is not delivery evidence.

Run `python -B tools/newton-motion/prepare.py --output <new-owned-directory>` to recover the fixed package through the production extractor.
Existing output directories are preserved and rejected. No solver, GPU, network download or mesh generation is needed for preparation.
