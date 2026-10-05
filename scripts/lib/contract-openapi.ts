export type Json =
  null | boolean | number | string | Json[] | { [key: string]: Json };
export const removedOperations = [
  '/api/v1/knowledge/',
  '/api/v1/notifications',
  '/api/v1/auth/password-reset',
  '/api/v1/jobs',
  '/api/v1/system/cache',
];
const object = (value: Json | undefined): { [key: string]: Json } =>
  value && !Array.isArray(value) && typeof value === 'object' ? value : {};
export function retainedOpenApi(source: Json): Json {
  const api = structuredClone(object(source));
  const paths = object(api.paths);
  for (const path of Object.keys(paths))
    if (
      removedOperations.some((prefix) =>
        prefix.endsWith('/')
          ? path.startsWith(prefix)
          : path === prefix || path.startsWith(`${prefix}/`),
      )
    )
      delete paths[path];
  api.paths = paths;
  const components = object(api.components);
  const needed = new Set<string>();
  function visit(value: Json | undefined) {
    if (Array.isArray(value)) {
      value.forEach(visit);
      return;
    }
    if (!value || typeof value !== 'object') return;
    const reference = value.$ref;
    if (
      typeof reference === 'string' &&
      reference.startsWith('#/components/')
    ) {
      if (!needed.has(reference)) {
        needed.add(reference);
        const [, , category, name] = reference.split('/');
        const component = object(components[category])[name];
        if (!component)
          throw new Error(`Dangling OpenAPI component: ${reference}`);
        visit(component);
      }
    }
    if (Array.isArray(value.security))
      for (const requirement of value.security)
        for (const name of Object.keys(object(requirement))) {
          const reference = `#/components/securitySchemes/${name}`;
          if (!needed.has(reference)) {
            needed.add(reference);
            const scheme = object(components.securitySchemes)[name];
            if (!scheme) throw new Error(`Missing security scheme: ${name}`);
            visit(scheme);
          }
        }
    Object.entries(value)
      .filter(([key]) => key !== 'components')
      .forEach(([, child]) => visit(child));
  }
  visit(api);
  const retained: { [key: string]: Json } = {};
  for (const reference of needed) {
    const [, , category, name] = reference.split('/');
    retained[category] ??= {};
    object(retained[category])[name] = object(components[category])[name];
  }
  api.components = retained;
  // Remove only unused tag declarations; each retained operation keeps its tags.
  if (Array.isArray(api.tags)) {
    const names = new Set(
      Object.values(paths).flatMap((item) =>
        Object.values(object(item)).flatMap((operation) =>
          Array.isArray(object(operation).tags)
            ? (object(operation).tags as Json[])
            : [],
        ),
      ),
    );
    api.tags = api.tags.filter((tag) => names.has(object(tag).name));
  }
  return api;
}
export function canonical(value: Json, key = ''): Json {
  if (Array.isArray(value)) {
    const items = value.map((item) => canonical(item));
    // These declaration arrays are sets. Example/default payload arrays retain order.
    if (
      [
        'required',
        'enum',
        'tags',
        'security',
        'allOf',
        'anyOf',
        'oneOf',
        'parameters',
      ].includes(key)
    )
      items.sort((a, b) => JSON.stringify(a).localeCompare(JSON.stringify(b)));
    return items;
  }
  if (value && typeof value === 'object')
    return Object.fromEntries(
      Object.entries(value)
        .sort(([a], [b]) => a.localeCompare(b))
        .map(([name, item]) => [name, canonical(item, name)]),
    );
  return value;
}
export function semanticDifferences(expected: Json, actual: Json): string[] {
  const a = canonical(expected),
    b = canonical(actual);
  const differences: string[] = [];
  function compare(
    left: Json | undefined,
    right: Json | undefined,
    path: string,
  ) {
    if (JSON.stringify(left) === JSON.stringify(right)) return;
    if (
      left &&
      right &&
      !Array.isArray(left) &&
      !Array.isArray(right) &&
      typeof left === 'object' &&
      typeof right === 'object'
    ) {
      for (const key of [
        ...new Set([...Object.keys(left), ...Object.keys(right)]),
      ].sort())
        compare(
          left[key],
          right[key],
          `${path}/${key.replaceAll('~', '~0').replaceAll('/', '~1')}`,
        );
    } else differences.push(path || '/');
  }
  compare(a, b, '');
  return differences;
}
