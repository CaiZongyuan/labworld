# Restore This Browser’s Layout Draft

Goal: edit Placement character by character, resume a private draft after refresh, and recover from a shared-layout conflict.

## Starting State and Changes

Complete [Edit Layout and Register Location](edit-layout.en.md). Keep the same Lab, bench, and beaker. Sign in as a Member and prepare a second browser. Saving writes the shared layout. Input and local recovery do not write to the server.

Run commands from the repository root. Use Node 24 and pnpm. Docker is not required.

```bash
pnpm install --frozen-lockfile
pnpm dev
```

Open <http://127.0.0.1:5173/lab>. Select the original Lab and beaker, then enter **Edit layout**. Sources are the [numeric editor](../../packages/views/src/lab/layout-editor.tsx), [browser drafts](../../packages/views/src/lab/layout-draft-storage.ts), and [workbench context](../../packages/views/src/lab/workbench-context.tsx). [Layout saving](../../packages/server/src/lab/world/layout.ts) retains its version check.

## Enter, Refresh, and Save

1. Clear **X (m)** and enter `-`. The text remains. Its range hint shows that this is not yet a valid number. **Save layout** is unavailable.
2. Refresh, then enter **Edit layout**. This browser restores `-` and the original layout baseline. The shared World retains its saved version.
3. Continue with `.25`. The text is `-.25`; valid Placement is `-0.25 m`. Language and theme changes preserve spelling and insertion position.
4. Refresh and enter editing again. The page explains that it restored a private draft. Recovery does not save or change Registered Location.
5. Choose **Save layout**. After **Saved** appears, refresh. The saved Placement returns, and the private draft is cleared.

Position and rotation absolute values are at most 10000. Rotation uses rad. Scale ranges from 0.001 to 1000. Invalid text remains with a range hint. It neither updates valid Placement nor permits saving. Correct the input to continue. Dragging an axis displays its new valid value; unfinished text on other axes remains.

## Compare Another Browser

1. Change the beaker X to `2` in the first page. Leave it unsaved.
2. Sign in as the same user in another browser and open this Lab. It shows the saved World, without the first browser’s private changes.
3. Change and save the bench X in the second page. Refresh the first. Its beaker draft retains the original baseline and shows **Layout changed; draft retained**.
4. Choose **Reload and keep draft**. Check the latest layout, then **Retry save**. Unchanged nodes and another editor’s new nodes remain. If both editors changed one node, an explicit retry uses the local node draft.
5. Refresh the second page and check the same saved results. Registered relationships and their provenance remain unchanged.

Drafts are isolated by deployment, user, Lab, and format version. View changes, Lab changes, and disconnection do not transfer drafts. The same user can resume after signing back into the original deployment. Other users and browsers read the server-saved layout.

## Continue After Failure

When browser storage is unavailable, input and drafts remain on this page. The message tells you to check the saved World before leaving. Save valid changes and confirm the server result. Page retention does not establish refresh recovery. After storage becomes writable, further edits can persist again.

A rejected save or lost response retains the draft. Read the current World first and check whether the save committed. If versions differ, use explicit reload and retry. Refresh does not submit another save.

To adopt the server layout, choose **Discard draft and reload**. A successful reload clears this Lab’s private draft. It does not write a new layout or change device programs. Invalid stored content is not automatically applied; the server World remains unchanged.

## Verify and Continue

Complete browser storage implementation:

<<< ../../packages/views/src/lab/layout-draft-storage.ts

```bash
pnpm exec vitest run apps/web/src/lab-layout-drafts.test.tsx packages/views/src/lab/layout-editor.test.tsx packages/views/src/lab/layout-draft-storage.test.ts
LAB_WORD_MIGRATION_DESKTOP=false node scripts/e2e-suite.mjs tests/e2e/lab-layout-drafts.spec.ts
```

Views use ordinary controls; MSW replaces only HTTP. The browser journey uses owned Node/Web services, identity, World, and WebGL. It creates and cleans temporary services and data. It does not use existing development data. Continue with [Reliable Synchronization and Recovery](reliable-sync.en.md) for shared World, disconnection, and authentication expiry.
