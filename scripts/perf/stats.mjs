// Shared min/avg/max shaping for report sample series. Empty input (or an
// all-null field, after the caller filters) shapes to null rather than
// NaN, so reports can say "not collected" instead of printing garbage.

export const stats = (values) =>
  values.length === 0
    ? null
    : {
        min: Math.min(...values),
        avg: +(values.reduce((a, b) => a + b, 0) / values.length).toFixed(1),
        max: Math.max(...values),
      };
