export type DuplicateField = { path: Array<string | number>; key: string };
const duplicates = new WeakMap<Request, DuplicateField[]>();

function scalarString(value: string) {
  for (let index = 0; index < value.length; index++) {
    const code = value.charCodeAt(index);
    if (code >= 0xd800 && code <= 0xdbff) {
      const next = value.charCodeAt(++index);
      if (!(next >= 0xdc00 && next <= 0xdfff))
        throw new SyntaxError('Malformed Unicode scalar');
    } else if (code >= 0xdc00 && code <= 0xdfff)
      throw new SyntaxError('Malformed Unicode scalar');
  }
}
// JSON.parse supplies grammar validation; this bounded scan retains duplicate fields
// before native object construction collapses them, and preserves Serde scalar rules.
export function inspectJson(text: string): DuplicateField[] {
  JSON.parse(text);
  let position = 0;
  const found: DuplicateField[] = [];
  const whitespace = () => {
    while (/^[\x20\t\r\n]$/.test(text[position] ?? '')) position++;
  };
  function string() {
    const start = position++;
    while (text[position] !== '"') {
      if (text[position] === '\\') position++;
      position++;
    }
    const value = JSON.parse(text.slice(start, ++position)) as string;
    scalarString(value);
    return value;
  }
  function value(path: Array<string | number>, depth: number) {
    if (depth > 128)
      throw new SyntaxError('JSON nesting exceeds the retained limit');
    whitespace();
    if (text[position] === '"') {
      string();
      return;
    }
    if (text[position] === '{') {
      position++;
      whitespace();
      const seen = new Set<string>();
      while (text[position] !== '}') {
        const key = string();
        if (seen.has(key)) found.push({ path, key });
        seen.add(key);
        whitespace();
        position++;
        value([...path, key], depth + 1);
        whitespace();
        if (text[position] !== ',') break;
        position++;
        whitespace();
      }
      position++;
    } else if (text[position] === '[') {
      position++;
      whitespace();
      let index = 0;
      while (text[position] !== ']') {
        value([...path, index++], depth + 1);
        whitespace();
        if (text[position] !== ',') break;
        position++;
      }
      position++;
    } else {
      const start = position;
      while (position < text.length && !/[\x20\t\r\n,\]}]/.test(text[position]))
        position++;
      const token = text.slice(start, position);
      if (/^[-0-9]/.test(token) && !Number.isFinite(Number(token)))
        throw new SyntaxError('JSON number out of range');
    }
  }
  value([], 0);
  return found;
}
export function rememberJson(request: Request, fields: DuplicateField[]) {
  duplicates.set(request, fields);
}
export function duplicateStructField(
  request: Request,
  fields: readonly string[],
  path: Array<string | number> = [],
) {
  return (
    duplicates
      .get(request)
      ?.some(
        (entry) =>
          entry.path.length === path.length &&
          entry.path.every((part, index) => part === path[index]) &&
          fields.includes(entry.key),
      ) ?? false
  );
}
