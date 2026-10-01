# Shared Interface Components

Goal: reuse Lab Word components and tokens and inspect their states in the showroom. Start and sign in using [quick start](../getting-started/quickstart.md).

## Inspect A Real Component

Open settings from the account entry at the lower left, then open the design system. Inspect a button, input or another existing scene in light/dark, disabled and error states. Showroom data is simulated and does not change equipment or knowledge resources.

The [design-system View](../../packages/views/src/design-system/design-system-view.tsx)composes scenes. Shared implementations include [Button](../../packages/ui/src/components/button.tsx)and [Input](../../packages/ui/src/components/input.tsx)under `packages/ui/src/components/`. [styles.css](../../packages/ui/src/styles.css)owns color and sizing tokens.

## Use Them In Lab

Import existing components from `@labos-threejs/ui/components/...`. Equipment selection, GLB import and asset information belong to Lab views; shared UI does not import equipment rules. Before adding a component, confirm existing controls cannot express the required state. Pass business state through explicit parameters.

Denied business access must produce a clear result; disabled buttons do not replace server authorization. Loading and error states retain stable control sizes and keyboard focus. Check narrow screens and both languages for overlapping text.

## Validate

```bash
pnpm exec vitest run apps/web/src/design-system.test.tsx
pnpm typecheck
```

Run from the repository root. View checks observe showroom interactions; type checking validates component contracts. Inspect actual layout, theme and focus in the browser. See [Viewer validation boundaries](lab-viewer.md)for real 3D rendering.
