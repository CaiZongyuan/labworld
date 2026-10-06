/** Compare RFC3339 instants without collapsing a source's sub-millisecond fraction. */
export function instantNanoseconds(value: string): bigint {
  const match = value.match(
    /^(\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d)(?:\.(\d{1,9}))?(Z|[+-]\d\d:\d\d)$/,
  );
  if (!match) throw new Error('Invalid precise instant');
  const second = Date.parse(match[1] + match[3]);
  if (!Number.isFinite(second)) throw new Error('Invalid precise instant');
  return BigInt(second) * 1000000n + BigInt((match[2] ?? '').padEnd(9, '0'));
}
export function addSeconds(value: string, seconds: number): string {
  const instant = instantNanoseconds(value) + BigInt(seconds) * 1000000000n;
  const fraction = value.match(/\.(\d+)/)?.[1];
  const remainder = ((instant % 1000000000n) + 1000000000n) % 1000000000n;
  const whole = (instant - remainder) / 1000000000n;
  return (
    new Date(Number(whole) * 1000).toISOString().slice(0, 19) +
    (fraction
      ? '.' + remainder.toString().padStart(9, '0').slice(0, fraction.length)
      : '') +
    'Z'
  );
}
