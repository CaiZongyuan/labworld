# Pinned Newton scene candidate

The registered profile is `sha256:499280ca3f82a759c8d7730fff556c632be48c2bfc290c687d5ed488ddc117cc`.
`representations/base.glb` retains the exact combined archive `sha256:fcddb20fbe664cbeceee1c95cee24d4ccf9e4388b858d9808b7ed5a49e852e20`.
The ten original visual geometries, maker meshes/licenses, body inertias, materials and collision shapes are retained.
Eleven locally derived collision members and their provenance remain in the fixed archive allowlist.

The GPU measurements below were recorded with profile `sha256:f85a5bed3be68d1c901298e6c976d539030fe4458f24b621a3b921de10d97bb1`. The current profile corrects Lab World attribution metadata and its resource hashes; geometry, scene, program and solver inputs remain unchanged.

The predefined program contains fourteen records. Cartesian descent stays 5 mm behind the final grip along its long axis, then enters horizontally at cap height. Closure pauses for one second. Joint targets close from 0.4 to 0.3 during lift, then 0.3 to 0.2 during held. These targets maintain contact without changing motor force or friction. The source lift goal is 12 mm; the acceptance threshold remains 6 mm.

The genuine 4320-step GPU measurement reached 9.003527 mm rise and passed the independent loaded gate for ten consecutive samples. After release, 15 consecutive samples met the seated criteria from step 3448 through 3560. The last sample at step 4320 did not meet those criteria; the evidence validates that window, not permanent seating. Native 256-contact/512-constraint guards passed 4321 checks; observed peaks were 10/22/46 and overflow was zero. Brief shoulder/lower-arm contact at step 968 remains in the diagnostic evidence, so clearance over the entire path is not established. Viewer/Recording acceptance, independent final review and final-head CI remain pending.

Run `python -B tools/newton-motion/prepare.py --output <new-owned-directory>` to recover this exact package. Existing directories are rejected. Preparation requires no solver, GPU, network download or mesh generation.
