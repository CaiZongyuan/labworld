SO-101 descriptions and checked-in meshes are from TheRobotStudio/SO-ARM100 at
a758567c3978dfeefe282ede0500085a48fe8f78, published under Apache-2.0.
The original MJCF credits onshape-to-robot and documents its motor parameter source.
The maker's simulation README also credits Open Duck Mini motor parameters.

Lab Word modifies the scene, authors vial/rack/mat geometry, converts Viewer meshes,
and supplies its fixed coordinate mapping, dynamics configuration and trajectory.
These changes do not claim measured equivalence to NVIDIA's SysID conversion.
No NVIDIA USD, MDL, texture or converted robot asset is distributed here.
No license for unrelated external Onshape documents or trademark endorsement is inferred.

Lab Word derives six follower and five moving collision candidates from the original
maker STLs. The exact derived OBJ, modification notices and provenance are retained
in the pinned base GLB physics archive. The production profile is a #73 WIP candidate;
actual compiled coverage/support, loaded grasp and Viewer/Recording acceptance remain
pending. This source registration does not certify physical fidelity or issue delivery.

Discovery candidate: explicit builder gap0m with unchanged activation margin0m.
Actual capacities/counts fail closed at constructor and each native step; compiled
267-record classification and paired active-contact equality are pending verification.
