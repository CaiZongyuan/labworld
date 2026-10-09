# Publish Documentation

Goal: publish validated bilingual Lab Word documentation to your GitHub Pages. Source push permission is required; first-time Pages setup requires repository administration. These steps push static artifacts; a local build does not publish.

## 1. Check Repository And Build

[site.json](../site.json)declares `CaiZongyuan/labworld` with `/labworld/` as its default base. Commit and push source first so footer links have an online revision. Markdown and `apps/docs/public/` are inputs; `.generated` and VitePress dist are derived.

```bash
pnpm docs:check
pnpm docs:build
```

Expect the build checker to verify bilingual pages and internal targets under the base. Unpublished source still renders locally, but GitHub revision links do not establish online availability.

## 2. Enable Pages

```bash
node scripts/publish-docs.mjs
```

The script commits dist to `gh-pages` without switching the source branch. In GitHub **Settings → Pages → Build and deployment**, select **Deploy from a branch**, `gh-pages`, `/ (root)`.

After GitHub CLI login:

```bash
node scripts/publish-docs.mjs --request-build
```

This checks Pages configuration, requests a build, matches the artifact commit and reads the published source revision. A successful push does not establish site availability. If the build is not ready, inspect the reported reason and Pages status.

## 3. Later Publication

[CI](../../.github/workflows/ci.yml)pushes validated documentation and requests Pages builds after successful `main` checks. Initial repository setup is still required. Pushes with the Actions token do not trigger Pages builds automatically, so the script requests one explicitly.

The configured destination is `https://caizongyuan.github.io/labworld/`; verify actual publication separately. Set `DOCS_BASE` for custom paths, for example `DOCS_BASE=/manual/ pnpm docs:build`. Check locale switching, search and navigation before publication.
