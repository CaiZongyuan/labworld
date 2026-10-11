import { ModelImportError } from './glb.ts';
/** Private opt-in diagnostic branch only; target values and callbacks stay original. */
export function observeLabRender(input: {
  producer: 'loader' | 'resource' | 'appearance' | 'boundary';
  stage: string;
  asset?: string;
  appearance?: string;
  node?: string;
  renderer?: object | null;
  cause?: unknown;
  aborted?: boolean;
  key?: string | null;
}) {
  try {
    const sink = (
      globalThis as typeof globalThis & {
        [key: symbol]: ((row: Record<string, unknown>) => void) | undefined;
      }
    )[Symbol.for('lab-word.lab334-observer')];
    if (!sink) return;
    const { cause, ...fields } = input;
    const name = cause instanceof Error ? cause.name : null;
    const category =
      name &&
      [
        'Error',
        'TypeError',
        'RangeError',
        'SyntaxError',
        'DOMException',
      ].includes(name)
        ? name
        : cause === undefined
          ? null
          : 'OtherError';
    sink({
      ...fields,
      category,
      key: cause instanceof ModelImportError ? cause.key : input.key,
    });
  } catch {
    try {
      (globalThis as { [key: symbol]: { invalidate: () => void } | undefined })[
        Symbol.for('lab-word.lab334-state')
      ]?.invalidate();
    } catch {
      /* Missing health makes evidence unavailable. */
    }
    // Even a failed observer/getter/notification cannot preempt original behavior.
  }
}
