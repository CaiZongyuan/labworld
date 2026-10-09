# Web experience accepted on 2026-10-01

Implementation input: the user's accepted v1/v2 interactive previews and their final corrections. The user explicitly requested implementation without another preview. The starting revision is `d0a5d72`; this document records the accepted behavior, not a claim that all validation has passed.

## Accepted behavior

- Use the reference direction from `docs/ui/references/`: neutral navigation and work surfaces, compact headings and controls, thin dividers, row-based lists and restrained category colors.
- The only global user entry is at the lower left. Clicking it opens settings directly, with no intermediate menu. Settings, API Keys, design system and system status are absent from the main navigation list.
- Settings has its own sidebar immediately beside the main sidebar. API Keys, the existing component showroom and system status operate inside this settings layout. Their prior URLs remain usable as deep links.
- The desktop main sidebar can be resized with a pointer and keyboard. Width is remembered on this device, with a default of 224px and bounds of 200px to 360px. Narrow screens retain the navigation drawer and usable settings selection.
- The topbar identifies the current page and exposes appearance/language actions. It has no duplicate user avatar or misleading organization/workspace selector.
- User avatars use the same pinned DiceBear scheme as bio-discovery-x, defaulting to Lorelei. Knowledge-base icons default to Glass and can be configured with the reference's glyph and color choices.
- The user chose device-only persistence for this iteration. Preferences are scoped by signed-in user and knowledge-base identity, remain independent of backend permissions and do not modify account or knowledge-base data. Choices take effect on confirmation; cancel preserves the previous choice.
- Documents use compact rows with title, update time and version. New, search, open, read, edit and explicit save remain connected to the real APIs. Reading and editing retain separate routes, wide editing shows source and preview, and narrow editing uses modes.
- Preserve draft protection, conflicts, denied permissions, attachment transfer and export behavior. Language/theme changes and sidebar resizing preserve active input. The shell remains unaware of concrete examples, and removing an example keeps Core settings usable.

## Evidence

The v1 HTML is retained under `.scratch/web-experience/v1/preview.html`, SHA-256 `920ba39aab3a4c15ec148659fa697d23ac0333da0158dc7dfca94cb29be4464f`. v2 and the user's recorded feedback remain in the neighboring preview directory. The local files are design evidence; the behavioral criteria above are the durable implementation reference.

Validate through the existing React View interfaces, contract/boundary checks, frontend build and bundle budget. Browser evidence covers actual layout, width dragging, desktop/narrow views, theme/language and the critical journey. Record unavailable checks instead of treating DOM-only checks as visual acceptance.

The implementation's local validation on 2026-10-01 passed 247 frontend tests (4 skipped), TypeScript, ESLint, formatting and the Web build. The built assets passed the unchanged bundle checker at 216.2 KiB initial gzip, with the required lazy boundaries retained. Standards and Spec review findings were fixed and reviewed again.

Acceptance remains incomplete for browser layout and pointer interaction: the environment denied local server listening and browser execution. The full `just check`, docs/boundary checks and subprocess-dependent tooling checks were also blocked by environment permissions. Detailed commands and results are retained in `.scratch/web-experience/verification.md`; these limitations require verification in a normal development environment before merge.
