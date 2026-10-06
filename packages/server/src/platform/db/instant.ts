/** Normalize the driver's timestamp text without letting Date truncate its fraction. */
export function utcInstant(value: string): string {
  const matched = value.match(
    /^(\d{4}-\d\d-\d\d)[ T](\d\d:\d\d:\d\d)(?:\.(\d{1,6}))?(Z|[+-]\d\d(?::?\d\d)?)$/,
  );
  if (!matched) throw new Error('Invalid precise timestamp');
  const zone =
    matched[4] === 'Z'
      ? 'Z'
      : matched[4].length === 3
        ? `${matched[4]}:00`
        : matched[4];
  const second = new Date(`${matched[1]}T${matched[2]}${zone}`);
  if (!Number.isFinite(second.getTime()))
    throw new Error('Invalid precise timestamp');
  return `${second.toISOString().slice(0, 19)}.${(matched[3] ?? '').padEnd(6, '0')}Z`;
}
