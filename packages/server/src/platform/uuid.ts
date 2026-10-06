// uuid 1.26.1 parse_str compatibility: simple, hyphenated, braced, lowercase URN prefix.
export function canonicalUuid(input: string): string | undefined {
  let value = input;
  if (input.length === 38 && input.startsWith('{') && input.endsWith('}'))
    value = input.slice(1, -1);
  else if (input.length === 45 && input.startsWith('urn:uuid:'))
    value = input.slice(9);
  if (/^[0-9a-fA-F]{32}$/.test(value) && input.length === 32)
    value = `${value.slice(0, 8)}-${value.slice(8, 12)}-${value.slice(12, 16)}-${value.slice(16, 20)}-${value.slice(20)}`;
  if (
    !/^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$/.test(
      value,
    )
  )
    return undefined;
  return value.toLowerCase();
}
