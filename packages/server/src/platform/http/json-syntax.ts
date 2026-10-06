export type DuplicateField = { path: Array<string | number>; key: string };
type JsonInspection = {
  duplicates: DuplicateField[];
  nonI64Numbers: Array<Array<string | number>>;
};
const inspections = new WeakMap<Request, JsonInspection>();
const samePath = (
  left: Array<string | number>,
  right: Array<string | number>,
) =>
  left.length === right.length &&
  left.every((part, index) => part === right[index]);

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
// Native parsing collapses duplicate fields and converts 0.0/0e0 into integers.
// Retain the wire distinctions needed by each typed request's Serde rules.
export function inspectJson(text: string): JsonInspection {
  JSON.parse(text);
  let position = 0;
  const found: DuplicateField[] = [];
  const nonI64Numbers: Array<Array<string | number>> = [];
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
      if (
        /^[-0-9]/.test(token) &&
        (!/^-?(?:0|[1-9][0-9]*)$/.test(token) ||
          BigInt(token) < -9223372036854775808n ||
          BigInt(token) > 9223372036854775807n)
      )
        nonI64Numbers.push(path);
    }
  }
  value([], 0);
  return { duplicates: found, nonI64Numbers };
}
export function rememberJson(request: Request, inspection: JsonInspection) {
  inspections.set(request, inspection);
}
export function invalidI64Field(
  request: Request,
  field: string,
  path: Array<string | number> = [],
) {
  return (
    inspections
      .get(request)
      ?.nonI64Numbers.some((entry) => samePath(entry, [...path, field])) ??
    false
  );
}
export function duplicateStructField(
  request: Request,
  fields: readonly string[],
  path: Array<string | number> = [],
) {
  return (
    inspections
      .get(request)
      ?.duplicates.some(
        (entry) => samePath(entry.path, path) && fields.includes(entry.key),
      ) ?? false
  );
}
