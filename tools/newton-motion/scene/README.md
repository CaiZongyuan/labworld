# Pinned Newton scene candidate

The registered profile is `sha256:f85a5bed3be68d1c901298e6c976d539030fe4458f24b621a3b921de10d97bb1`.
`representations/base.glb` retains the exact combined archive `sha256:d86c6094aa74640872afd7ce3d659b47cfed121dd7ec88d60e465ccec77d5f59`.
The ten original visual geometries, maker meshes/licenses, body inertias, materials and collision shapes are retained.
Eleven locally derived collision members and their provenance remain in the fixed archive allowlist.

The predefined program contains fourteen records. Cartesian descent stays 5mm behind the final grip along its long axis, then enters horizontally at cap height. Closure pauses for one second. Joint targets close from0.4 to0.3 during lift, then0.3 to0.2 during held; these targets maintain contact without changing motor force or friction. The source lift goal is12mm, while the actual acceptance threshold remains6mm.

The genuine4320step GPU measurement reached9.003527mm rise, passed an independent consecutive-ten-sample loaded gate and then released/seated. Native256contact/512constraint guards passed4321 checks; observed peaks were10/22/46 and overflow0. One brief shoulder/lower-arm contact during entry is retained in the diagnostic evidence. Viewer/Recording acceptance, independent final review and final-head CI remain pending.

Run `python -B tools/newton-motion/prepare.py --output <new-owned-directory>` to recover this exact package. Existing directories are rejected. Preparation requires no solver, GPU, network download or mesh generation.
