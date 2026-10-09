# 2026-10-09 暂停交接的可携带审查证据

本文件保存最新候选的正式审查文字，方便新环境读取。它不是新的审查或合并批准。固定候选、原基线、源码变化、实际CI和原始runner证据仍需共同核对。完整早期审查、路径hash pin、PNG和资源JSON在本机 `.scratch/vnext-continuation-20261006/evidence/`，换机器时需要携带；若原输入或原报告缺失，重新建立受影响覆盖，不能只凭 PASS 字样复用。

- #31：base3b75a1f，head18bfaa81，tree6fd2fd16，31 paths。当前WebCI失败17例，尚未集成。
- #36：base3b75a1f，headcf15edfe，tree813cb937，35 paths。最后一文件测试修复覆盖所有前34个未变hash，独立双轴PASS；最终CI37946870625 verify/Windows成功、Web失败（Foundation busy与lifecycle15>14），最新趋势修复通过，仍未集成。
- #37：base3b75a1f，headb957dd48，treef1b9c203，23 paths，完整patch61cd878d43285755b2e1f24220a2f1b1f4cece6433a4ceb9cf9473288abcb0d4。独立双轴PASS，最终WebCI两例失败。

旧报告中“pending”描述其捕获时点。当前暂停状态以[交接](labworld-vnext-pm-pause-2026-10-09.md)和GitHub当前head结果为准。下文原样保留已保存的审查文字；本机路径不代表GitHub有该scratch文件。

## #31 — product-31-rebase32-standards-refresh.md

原文件 SHA256 `a530143a2477672078c5f1fa1b8a1c1ec614e256365adbb94da70b82c3d8fb5c`。

Standards: PASS for the semantic rebase, reporter and trend mask delta. Non-author root, 2026-10-09T13:11:25.438147+00:00. Base `3b75a1fe29ff5579361080121aec3b9b5c0fcc1c`; complete clean29-path candidate `4b5628952e42fffee19beb130af10a63b55c7b3b` / tree `205ce68b0ab4192170cdfde56a2b565aa73c1216`, content `d45ff2ac408a7f089626da00c47cb42408765f059a85b8e417f9ad8eec961e66`. Scope and hashes independently verified in the accompanying Spec/observer refresh. Exact comparison: `git diff 3b75a1fe29ff5579361080121aec3b9b5c0fcc1c 4b5628952e42fffee19beb130af10a63b55c7b3b --`.

Reused prior independent complete #31 Standards reviews for byte-identical native viewport, label collision algorithm, native models, camera framing, metadata/generator/boundary and lifecycle/World consumers. The current integration changes only the merged WorldView camera prop union, incoming #32/#33 composition and tutorial links plus the separately reviewed bounded reporter/mask additions. Immediate trend/detail/records consumers retain their delivered upstream implementation. Explicit fitNode/top/locate actions keep ownership in WorldView; existing recent-minute callback reaches WorldLabels without duplicate prop registration. No passive fit callback, new business subscriber, Core metadata import, duplicated domain state, permission/schema/budget change or unrelated source was introduced.

The sensor-card selector asserts unique cardinality and measures the actual card within the unchanged canvas; original raster/passive/orbit bounds are preserved. Reporter both-axes review is `product-31-timeout-reporter-independent-review.md`, including real public poll/privacy controls and exact two-file adoption hashes. Recorded no-change/bounded parser simplification remains valid. Public Views45/45, type/lint/format/docs receipts were read; required real trend case on this baseline is still pending.

Zero required documented-standard findings. This small integration delta uses one independent root for separate Standards and Spec under repository policy; prior full native/algorithm reviews retain their separate contexts. Unchanged native runtime evidence can be reused by inputs, but current final-head verify/Web/Windows checks and actual integration remain mandatory. Historical failure causes, any optional Network diagnostic adoption and future main movement are separate; this review does not turn old CI failures into passes.

## #31 — product-31-rebase32-spec-refresh.md

原文件 SHA256 `7d6d6dbb3ba879f7635e71d0bb2c6dff97edcfc0efb2c3d3328e1093a0699498`。

Non-author root, 2026-10-09T13:08:34.427353+00:00. Complete clean candidate `4b5628952e42fffee19beb130af10a63b55c7b3b` / tree `205ce68b0ab4192170cdfde56a2b565aa73c1216`; base `3b75a1fe29ff5579361080121aec3b9b5c0fcc1c`. All29 path hashes/scope verified against `product-31-lightweight-rebase-3b75/final-candidate.json`; content `d45ff2ac408a7f089626da00c47cb42408765f059a85b8e417f9ad8eec961e66`. Root authored no candidate source.

Spec: PASS for the #32/#33 semantic rebase and trend-card mask delta; affected real trend runtime remains pending. Reused previous complete #31 product/camera/native/lifecycle/World and final Spec reviews only by unchanged inputs. Independently verified native viewport/labels/models/camera/metadata are byte-identical to published6f. Reviewed rebase range-diff, merged WorldView camera props/actions and upstream trend/record composition. #32 same-Entity receiver, effective Details/Operations visibility, recent-minute selection and original-record reset survive; #33 records remain in their owner. Explicit camera actions change fit intent; World/observation/selection/hidden trend updates add no passive fit. Tutorial links preserve spatial representation -> device details -> trends -> lights.

The trend raster mask now selects exactly one actual priority card containing Persistent sensor, then measures that card's rectangle relative to the original canvas. It does not select every label, crop the scene, replace the canvas, or relax passive0/orbit>30/area/deadline assertions. The changed public selector still needs its owning real trend case on this integrated baseline. No Core metadata dependency, backend/schema/API, placement, generic cube fallback or currentness contract changed. Reporter coverage is separately pinned in `product-31-timeout-reporter-independent-review.md`.

Read45/45 affected public Views/static/docs checks and bounded simplification. No fresh heavy scene/full suite is required solely for unchanged native source; current required CI must still execute final candidate. Historical readiness/pixel callback/resource/history-premise causes remain classified rather than presumed repaired. Independent Standards refresh for broader integration, affected trend runtime, final verify/Web/Windows CI and actual merge/tree/issue readback remain pending.

## #31 — product-31-final-network-adoption-review.md

原文件 SHA256 `ce56cc716d9b5d7e527bc919be311c5ae79f57d11f6e8b36fa0fe7b9d33bfac3`。

Standards: PASS. Spec: PASS. Non-author root 2026-10-09T13:32:28.525229+00:00. Complete clean31-path `18bfaa81be3f85ab72fa148a88f66f28bb1427d4` / tree `6fd2fd163189e8be825dfbb73f381422bc3a1984`, base `3b75a1fe29ff5579361080121aec3b9b5c0fcc1c`, content `d4c92fcaed8381fd6a3dc8855213c74a13d51c6c6e0fe2fd80491baa49ee621a`. All31 path hashes and all29 previously reviewed4b562 hashes independently verified. Exact helper81e6f42b matches the reviewed36 source byte-for-byte; caller64684661/adoption patch542c0733 inspected.

Foundation adds only the eight declared observer import/ownership/capture/mark/finalization lines. The original member/Agent/fullstorageState/model/world inputs, five-second readiness,240-second case and assertions stay identical; no36 private draft/seam/select handler or other product scope copied. Arming and two document captures remain asynchronous; only optional finalization is awaited after the original assertion and in owned cleanup. Existing helper privacy/resource/clock limits and six offline controls are reused by byte identity; Network clock/renderer attribution stays unknown unless proven. No product, lifecycle, budget, retention or history oracle changed.

Root's owning sensor trend/camera case passed25.320s on unchanged29 source inputs: passive raster0, orbit154854 pixels>30, actual single priority-card mask and chart/tooltip/table/persistent SDK provenance. Its suite/browser/API fixtures reconciled zero owned consumers and closed ports; Docker15/19/8 identities and existing persistent development services were preserved. See `product-31-lightweight-rebase-3b75/root-trend-result-and-resource-reconciliation.json`. Prior complete product/native/algorithm reviews and bounded simplification remain valid.

Single independent root reviewed this small exact diagnostic adoption across both axes under repository policy; prior full product reviews retain their separate actors. Final stable source may publish with explicit old6f lease and one mandatory current-head verify/Web/Windows CI; no further local heavy run justified here. Historical failures remain classified and unproven rather than claimed repaired. Main movement, actual merge/tree/issue completion and CI resource reconciliation remain mandatory before delivery.

## #36 — product-36-sensor-mask-standards-review.md

原文件 SHA256 `e3e99ff7e7732e80eabddca080e75733567f6a38c60d419d229603875ae119ff`。

**Standards PASS — zero required findings.** Independent non-author reviewer `advisor_ci_recovery`; Root owns the separate Spec decision.

Frozen candidate: base `3b75a1fe29ff5579361080121aec3b9b5c0fcc1c`, head `cf15edfe385f8bb77f738188b376d871ed26ee29`, tree `813cb93779f500750daa666b65676eaaa3367a7a`; handoff reports clean. Complete scope is 35 paths. Independently matched all source SHA-256 values in `product-36-implementation/sensor-mask-candidate-pin.json`; all 34 previously published paths match the `1f604db0522929a298ddf46236fe43b15dc1a171` pin unchanged, allowing prior review coverage to stand.

Bounded comparison: `git diff 1f604db0522929a298ddf46236fe43b15dc1a171 cf15edfe385f8bb77f738188b376d871ed26ee29 --`. Preserved delta SHA-256 `a2bf723a80cec3520b8acfe433ae8f0c4f8a0fb6ab6353bc8d541221b1100427`; full base-to-candidate patch SHA-256 `cfdecab9e33023edbfccbd16ff496205dca12d3c08ab7a813af539f6ff4d3b2a`. Both independently match their saved patches.

Reviewed the sole semantic delta in `tests/e2e/lab-trends.spec.ts`, existing mask/comparator and later camera/orbit consumers, public sensor setup, counterexample probe, receipts and four PNGs. The initial settling assertion now reuses actual sensor-label bounds from both captures. The single registered sensor and strict locator identify the target; missing/ambiguous bounds fail rather than silently enlarging the mask. Saved bounds occupy about 3% of the 692×755 canvas; the model and grid remain exposed.

The controlled public counterexample retains the real program and original threshold: sequence 5→7, 22.4→22.5 °C, same run/Nodes/Placement/canvas rectangle, 56 changed pixels inside the label and zero outside. Its original unmasked zero assertion genuinely fails at 5000ms. The original CI image pair was unsaved, so this establishes a cause-equivalent invalid premise, not proof of those exact CI frames. Viewed orbit evidence changes model/grid outside the label, with 50,734 pixels exceeding the retained >30 negative threshold.

Zero tolerance, RGB-sum >30 comparator, full-canvas capture, 5000ms poll, 90s case, later camera assertion and history/program guards remain unchanged. No product behavior or arbitrary allowance changed. This follows testing-strategy public observability/discrimination and development-flow bounded oracle-repair rules. The simplification record supports existing-helper reuse; no further required simplification emerged.

Read the targeted owning-green pass and recorded resource closure: counterexample reconciled, owning browser consumers absent, both owning services cleaned, no Docker resources owned. No validation or live resource inspection was executed by this reviewer; scratch report only. Spec approval, publication and final-head CI remain pending.

## #36 — product-36-sensor-mask-spec-review.md

原文件 SHA256 `ec92ea80ac9444dc054d1e7f5adeec143084eda0fc7fe93d10e923415201a7a6`。

Spec: PASS. Non-author root 2026-10-09T14:44:48.204672+00:00. Base `3b75a1fe29ff5579361080121aec3b9b5c0fcc1c`; complete clean35-path candidate `cf15edfe385f8bb77f738188b376d871ed26ee29` / tree `813cb93779f500750daa666b65676eaaa3367a7a`. All35 per-path hashes, all34 prior reviewed1f604 hashes and one-file delta a2bf723a80cec3520b8acfe433ae8f0c4f8a0fb6ab6353bc8d541221b1100427 independently verified. Reuse full36 product/spike/rebase/observer reviews solely for unchanged inputs.

Viewed the actual whole-canvas real-tick PNG pair: sensor22.4 ->22.5degC, World sequence5 ->7, same Entity/Run/Node/Placement and692x755 exposed canvas. All56 changed pixels lie inside the actual single sensor label, outside0. The original unmasked0 predicate is preserved as a real red with5000ms; orbit produces50,734 outside pixels>30. The mask occupies about3% of the canvas and leaves the sensor/grid exposed. This proves the original static-label premise can reject valid live behavior. The oldCI PNG pair was unsaved, so the counterexample does not uniquely attribute that historical case.

The only source repair reuses the existing measured label mask for both initial whole-canvas captures. It preserves full image extent, exactzero/RGB30 threshold, originalfive-second predicate/90-second case and later masked camera/orbit controls. No generic full-label exclusion, crop, renderer remount, private camera hook, fake observation, changedsampling/retention or pixel allowance. This is the smallest supported oracle correction; bounded simplification and scoped static checks pass.

The owning actual SDK/chart/tooltip/table/history journey passed15.290s on this exact source with cameraPixels0 and orbit55,727>30. All8 owning suite/browser/API ledgers completed/reconciledzero and fourAPIports refuse; existingDocker15/19/8 identities and persistent root runtime/data preserved. Independent Standards reports PASS separately. Required current-head verify/Web/Windows CI and actual integration remain pending; the candidate may publish with explicit old1f604 lease and one mandatory current-head run. User now requests finishing this repair, handoff/retrospective and stopping work: no new implementation/diagnostic phase is authorized for this PM after handoff.

## #37 — product-37-standards-review.md

原文件 SHA256 `457c2524ed525337a50a03334a42d5016af3cb024366d162d017596dc9e3f41a`。

# #37 independent Standards review

**Standards PASS — zero remaining required findings.** Reviewer `advisor_ci_recovery` is a non-author. This report approves only the Standards axis; Root owns Spec and delivery decisions.

Reviewed complete comparison: `git diff 3b75a1fe29ff5579361080121aec3b9b5c0fcc1c b957dd48e7b7d5b83db1e74e344a04929c4de041 --`. Final head `b957dd48e7b7d5b83db1e74e344a04929c4de041`, tree `f1b9c203421946cbb767f48cf2f7a6bbb25b9e3b`; clean worktree, 23 changed paths, six new files. Reviewer pin: `product-37-standards-reviewed-pin.json`; content hash `c45438ecc2c33406791085503a4c4467f58d81d1ed23413dad0ac5e352739494`; preserved patch hash `61cd878d43285755b2e1f24220a2f1b1f4cece6433a4ceb9cf9473288abcb0d4`. Final source hashes, patch hash, HEAD/tree and cleanliness were independently rechecked.

Reused the preserved 20-path initial review and refreshed all 11 changed/new paths since that snapshot, including the three added detail/trend consumers. Standards sources were AGENTS/CONTEXT, development/testing/experience/documentation rules, runtime/identity ADRs 0006–0008, code-review smell guidance and React guidance. Coverage includes operations modules, shared subscription/controller/World composition, observation presentation, records/dialog/CSS, public tests and paired documentation/navigation.

The one independent Standards finding is resolved: the narrow work-tab CSS no longer overrides the accepted 44px primary-touch minimum with 32px. `product-37-implementation/application-touch-final/narrow-geometry.json` records all four tabs at exactly 44px at 390/320, document width equal to viewport and a 560px contained table. `browser-touch-final.log` records the affected check passing.

Final consumer tracing confirms one canonical reconnect-aware `trendRevision` reaches Overview and Inspector. Scoped query keys, AbortSignal/session invalidation, visibility cleanup and the existing 5000ms automatic cadence remain; same-key requests coalesce. Transport-live governs HTTP-reader visibility while runtime availability governs current-value validity. Shared Workbench ownership, mounted WorldViewport, selection/drafts and Lab-owned rules remain coherent; no backend/API/schema/dependency/budget change was found. No optional broad refactor is required.

Attribution stays separate: Root found the Task `unknown` wire mismatch. This reviewer supplied availability/currentness and reconnect/shared-reader traces; Root classified their repairs as Spec findings. This report does not claim independent Standards credit or Spec PASS for those repairs.

Existing Views/reader/availability/reconnect receipts and browser evidence were read, not executed. The related-reader receipt reports 28 cases passing; the targeted reconnect receipt reports two passing. Earlier browser journey assertions completed before its old narrow-layout failure; the final affected geometry receipt addresses that failure. No source edits or test/build/browser/service/Docker/network/tracker mutations were performed; only scratch evidence was written. Root's Spec approval, required final-head CI and delivery remain pending.

## #37 — product-37-spec-review.md

原文件 SHA256 `170ea6b98c8513120b5bbd27d35b129c0eb7bf110976272aa4b730818764f424`。

Spec: PASS. Non-author root, 2026-10-09T14:04:16.273071+00:00. Base `3b75a1fe29ff5579361080121aec3b9b5c0fcc1c`; complete clean23-path candidate `b957dd48e7b7d5b83db1e74e344a04929c4de041` / tree `f1b9c203421946cbb767f48cf2f7a6bbb25b9e3b`; full patch SHA256 `61cd878d43285755b2e1f24220a2f1b1f4cece6433a4ceb9cf9473288abcb0d4`. Scope and per-path hashes independently captured in `product-37-spec-final-pin.json`. Root authored no candidate product/test source. GitHub#37/#24, actual32/33 main and latest default-space correction govern this review; parent specs remain unchanged.

Operating devices deduplicate active instrument/iot/sensor/robot Entity identities, include unplaced devices and separate Task counts from program Runs. All-key property validity reuses T02 with actual runtime availability; zero/false remain values and unknown stays unknown. Attention combines current-source expiry/quality/source-time facts with retained Task/Run outcomes, prioritizes actual wireunknown/interruption and then earliest relevant time. Manual contains/located_in traversal determines nearest Location; identity/status/region/unplaced filters and static/archive entries survive.

One Workbench/World subscription, mounted viewport and shared Inspector preserve Entity, layout inputs and scopes across space/overview/devices/records. Default /lab remains space; explicit valid view/entity links refresh and missing identities retain explicit recovery. Environment choices use actual sensors; delivered lazy TanStack trends and original activity/results remain in their owners. Offline keeps marked last-sync/read-only content and disables new writes; runtime unavailable currentness is distinct from live transport used by historical readers. Reconnect uses one controller-owned refreshRevision for every visible chart; unchanged stopped-device World/version still refreshes at the original5000ms cadence. Simultaneous same-Entity/range observers coalesce automatic reads with cancelRefetchfalse; explicit manual refresh and retained ranges/cache/source identity remain. Revocation stops old scope access.

Three required Spec findings are fixed with genuine public red/green: inventeduncertain -> actualunknown attention ordering; live-SSE availablefalse -> same-Entity lastreport/valid0 -> true recovery without new World; unchanged-version Inspector reconnect and dual-reader duplicate counts -> shared revision/cadence/coalescing. Read affected28 operations/existing-trend cases and prior27 availability/detail/sync passes, plus original53 source consumers and39 presentation/records cases. No backend/schema/SDK/API/dependency/budget or lifecycle expansion. Simplification is bounded and recorded.

Actual owning browser business assertions cover counters, sensorSVG, Member command, second browser+Agent same observed value, deep-link refresh, offline retained filter and original record. Its old320 layout failure is separately preserved; final affected presentation passes1440/1920 top and390Chinese/320English with document widths exact, readable visible table and allfour primary work tabs exactly44px. Root inspected final screenshots against accepted operations/spatial previews. Fixture/hidden-table oracle errors are classified and not claimed as product reds. All four author browser runs retain completed cleanup and no owned consumers; persistent root data/foreign Docker resources are preserved. Paired runnable guides/navigation and Lab ownership are delivered.

Independent Standards finaldelta and required final-head verify/Web/Windows CI remain separate merge obligations. Final CI covers complete gate/docs/current budgets; local tests do not replace it. Pending31/36 integration must preserve new trend revision/currentness and private draft/native camera intents through semantic baseline review. Source may publish to an authorized Draft PR with accurate verified/pending scope. Actual merge/tree/issue closure still required for #37 completion.
