# Use the spatial workbench

Goal: open a persistent Lab, select the same Entity through its directory or scene, and restore it from a link. Panel changes do not save the layout or reset the camera.

## Starting State And Changes

Complete [Persistent Labs and objects](persistent-world.md) first. Use the source version paired with this chapter. Keep the existing Lab and two independent objects. Run commands from the repository root. Viewing, selection, and panel changes do not write the persistent world.

This chapter moves the World query, single subscription, selection, layout drafts, and command attempts into the [Lab workbench context](../../packages/views/src/lab/workbench-context.tsx). The [space page](../../packages/views/src/lab/world-view.tsx) consumes that context. [Lab composition](../../packages/views/src/lab/app-example.tsx) preserves authentication and deferred loading. The [router adapter](../../apps/web/src/router.tsx) passes generic search parameters. The universal shell provides compact navigation without interpreting Lab identities.

```bash
pnpm install --frozen-lockfile
just dev
```

Open <http://127.0.0.1:5173/lab>. Sign in as the Member who registered the objects. The page opens the 3D space with its real Lab name and connection state.

## View And Select

1. Use **Open Lab** to choose the Lab from the previous chapter.
2. Click **Collapse navigation**. The narrow rail retains business entries and the single account entry at the bottom. Hover over an icon for its name. **Expand navigation** restores the navigation width.
3. Click **Open object directory**. Search by name or filter by category, unplaced state, or archived state. Directory checkboxes retain multiple selection.
4. Select a directory entry or its scene representation. Object info keeps the same Entity. Open **Details** to inspect its full identity. Multiple nodes can still represent one Entity.
5. Click **Close object directory** and **Close object details**. The camera retains its angle and the scene regains space. **Open object details** shows the current selection again.
6. Orbit and zoom to inspect the scene. **Fit model** changes the framing. **Grid** and **Performance** control their respective displays.

Closing a panel returns focus to its opening control or selection source. Escape closes the current panel. It does not discard drafts while you use an input or dialog. Main touch commands retain targets of at least 44px. Use the application topbar to change language or theme.

## Restore A Link

Selecting an object adds its Lab and primary Entity to the browser address. Refreshing confirms both identities against the server World. Additional selections and the Scene Node selection remain in the current workbench session.

| Parameter              | Current Behavior                                                        |
| ---------------------- | ----------------------------------------------------------------------- |
| `lab=<Lab UUID>`       | Open this Lab; omission selects the default item from the Lab list      |
| `entity=<Entity UUID>` | Restore the primary Entity in this Lab; omission leaves selection empty |
| `view=space`           | Open the 3D space; omission also opens space                            |

Example:

```text
/lab?lab=<Lab UUID>&entity=<Entity UUID>&view=space
```

Replace placeholders with the real UUIDs from the address. Space is the only delivered work view. Other `view` values show an explicit unavailable state. **Open 3D space** returns to the same Lab. `/`, `/assets`, and `/lab/asset` retain their existing entries.

## Drafts And Recovery

Switching between **Runtime** and **Edit layout**, or changing panels, retains an unsaved draft for the same Lab. Switching Labs does not apply its draft or selection to another Lab. Returning lets you continue the in-memory draft. Identity or deployment changes isolate protected data and operation attempts. This chapter does not restore private drafts after refresh. Save or explicitly discard before leaving the page.

Replace `entity` in the link with a missing UUID. The page shows **This Entity is unavailable.** It does not select another object. Click **Clear Entity link**, then select a valid object in the directory. A missing `lab` UUID shows **This Lab is unavailable.** Use **Open Lab** to choose a valid Lab explicitly.

Disconnecting retains the last snapshot with its source. The connection state no longer reports live synchronization. Commands that require a connection are disabled. **Reconnect** restores the subscription. Failed saves and 409 responses retain drafts; see [Edit the layout](edit-layout.md) for recovery. Late saves or registrations affect their original Lab. They do not replace the selection or draft in a newly chosen Lab.

## Verify And Continue

The complete workbench entry and context composition:

<<< ../../packages/views/src/lab/workbench.tsx

```bash
pnpm typecheck
pnpm exec vitest run apps/web/src/lab-workbench.test.tsx apps/web/src/lab-world.test.tsx apps/web/src/lab-sync.test.tsx
node scripts/e2e.mjs tests/e2e/lab-workbench.spec.ts
```

Views tests use MSW only at the HTTP boundary. Browser tests use real authentication, API, database, subscriptions, HDR, and WebGL. They check external canvas area, camera pixels, deep links, panels, focus, and narrow-screen commands. Continue with [shared device details](device-details.md). Check targets, Commands, actual observations and task results separately.
