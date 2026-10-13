import { createHash } from 'node:crypto';
import { z } from 'zod';
import { PublicFailure } from '../../platform/http/failure.ts';
import type { AssetDescription, AssetVersion } from './domain.ts';

export function invalidDescription(message: string): never {
  throw new PublicFailure(400, 'lab.invalid_asset_description', message);
}
const keywords = new Set([
  '$schema',
  'type',
  'properties',
  'required',
  'additionalProperties',
  'items',
  'enum',
  'const',
  'minimum',
  'maximum',
  'minLength',
  'maxLength',
  'minItems',
  'maxItems',
  'description',
  'title',
  'default',
  'unit',
]);

/** Bounded JSON Schema vocabulary; unsupported validation keywords fail explicitly. */
export function fieldSchema(schema: Record<string, unknown>) {
  let nodes = 0;
  const visit = (value: unknown, depth: number): void => {
    if (
      ++nodes > 1024 ||
      depth > 12 ||
      !value ||
      typeof value !== 'object' ||
      Array.isArray(value)
    )
      invalidDescription(
        'Use an object field schema within the supported complexity',
      );
    const entry = value as Record<string, unknown>;
    if (Object.keys(entry).some((key) => !keywords.has(key)))
      invalidDescription(
        'Use supported field schema keywords; external or recursive references are not supported',
      );
    if (
      ![
        'object',
        'array',
        'string',
        'number',
        'integer',
        'boolean',
        'null',
      ].includes(String(entry.type))
    )
      invalidDescription('Declare a supported field type');
    if (
      entry.unit !== undefined &&
      (typeof entry.unit !== 'string' ||
        !entry.unit.trim() ||
        entry.unit.length > 64 ||
        !['number', 'integer', 'array'].includes(String(entry.type)))
    )
      invalidDescription(
        'Units must be nonempty annotations on numeric fields',
      );
    for (const name of [
      'minimum',
      'maximum',
      'minLength',
      'maxLength',
      'minItems',
      'maxItems',
    ]) {
      if (
        entry[name] !== undefined &&
        (typeof entry[name] !== 'number' || !Number.isFinite(entry[name]))
      )
        invalidDescription('Schema bounds must be finite numbers');
    }
    for (const name of ['minLength', 'maxLength', 'minItems', 'maxItems']) {
      if (
        entry[name] !== undefined &&
        (!Number.isSafeInteger(entry[name]) || Number(entry[name]) < 0)
      )
        invalidDescription(
          'String and array bounds must be nonnegative integers',
        );
    }
    if (
      entry.required !== undefined &&
      (!Array.isArray(entry.required) ||
        entry.required.some(
          (name) =>
            typeof name !== 'string' ||
            !Object.hasOwn((entry.properties ?? {}) as object, name),
        ))
    )
      invalidDescription('Required fields must be declared property names');
    if (entry.properties !== undefined) {
      if (
        entry.type !== 'object' ||
        !entry.properties ||
        typeof entry.properties !== 'object' ||
        Array.isArray(entry.properties)
      )
        invalidDescription('Use object properties in object schemas');
      for (const child of Object.values(entry.properties))
        visit(child, depth + 1);
    }
    if (entry.type === 'array') visit(entry.items, depth + 1);
    if (
      entry.additionalProperties !== undefined &&
      typeof entry.additionalProperties !== 'boolean'
    )
      invalidDescription('additionalProperties must be boolean');
    if (entry.enum !== undefined && !Array.isArray(entry.enum))
      invalidDescription('enum must be an array of JSON values');
  };
  visit(schema, 0);
  const structuralSchema = (
    schema: Record<string, unknown>,
  ): Record<string, unknown> => {
    const value = { ...schema };
    delete value.default;
    // The converter treats enum/const as replacements for sibling constraints.
    // Preserve structural validation here and intersect literal constraints below.
    delete value.enum;
    delete value.const;
    if (value.properties)
      value.properties = Object.fromEntries(
        Object.entries(
          value.properties as Record<string, Record<string, unknown>>,
        ).map(([key, child]) => [key, structuralSchema(child)]),
      );
    if (value.items)
      value.items = structuralSchema(value.items as Record<string, unknown>);
    return value;
  };
  const literalConstraints = (
    schema: Record<string, unknown>,
    value: unknown,
  ): boolean => {
    if (Array.isArray(schema.enum) || Object.hasOwn(schema, 'const')) {
      const actual = JSON.stringify(canonical(value));
      const equal = (expected: unknown) =>
        actual === JSON.stringify(canonical(expected));
      if (Array.isArray(schema.enum) && !schema.enum.some(equal)) return false;
      if (Object.hasOwn(schema, 'const') && !equal(schema.const)) return false;
    }
    if (
      schema.properties &&
      value &&
      typeof value === 'object' &&
      !Array.isArray(value)
    ) {
      for (const [key, child] of Object.entries(
        schema.properties as Record<string, Record<string, unknown>>,
      )) {
        if (
          Object.hasOwn(value, key) &&
          !literalConstraints(child, (value as Record<string, unknown>)[key])
        )
          return false;
      }
    }
    if (schema.items && Array.isArray(value)) {
      for (const item of value)
        if (!literalConstraints(schema.items as Record<string, unknown>, item))
          return false;
    }
    return true;
  };
  try {
    return z
      .fromJSONSchema(structuralSchema(schema))
      .refine((value) => literalConstraints(schema, value));
  } catch {
    return invalidDescription('Use a valid supported JSON field schema');
  }
}
export function validateDescription(description: AssetDescription) {
  if (
    !/^[a-zA-Z0-9][a-zA-Z0-9._-]{0,63}\/[a-zA-Z0-9][a-zA-Z0-9._/-]{0,191}$/.test(
      description.asset_id,
    ) ||
    description.asset_id.includes('..') ||
    description.asset_id.endsWith('/')
  )
    invalidDescription('Use an asset identity in namespace/name form');
  if (JSON.stringify(description).length > 192 * 1024)
    invalidDescription('Asset descriptions must fit within 192 KiB');
  fieldSchema(description.configuration_schema);
  fieldSchema(description.state_schema);
  if (
    description.configuration_schema.type !== 'object' ||
    description.state_schema.type !== 'object'
  )
    invalidDescription('Configuration and state schemas must describe objects');
  for (const capability of description.capabilities) {
    fieldSchema(capability.parameters);
    fieldSchema(capability.result);
  }
  const resources = new Map(
    description.resources.map((resource) => [resource.key, resource]),
  );
  const used = new Set<string>();
  if (
    resources.size !== description.resources.length ||
    new Set(description.representations.map((entry) => entry.key)).size !==
      description.representations.length ||
    new Set(description.capabilities.map((entry) => entry.id)).size !==
      description.capabilities.length
  )
    invalidDescription(
      'Resource, representation and capability keys must be unique',
    );
  for (const representation of description.representations) {
    const keys = new Set(representation.resource_keys);
    if (
      keys.size !== representation.resource_keys.length ||
      new Set(representation.components.map((entry) => entry.key)).size !==
        representation.components.length
    )
      invalidDescription(
        'Representation resources and component keys must be unique',
      );
    for (const key of keys) {
      const resource = resources.get(key);
      if (!resource)
        invalidDescription('Every representation resource must be declared');
      if (
        (representation.purpose === 'visual' && resource.format !== 'glb') ||
        (representation.purpose === 'simulation' &&
          !['usd', 'urdf', 'json'].includes(resource.format)) ||
        (representation.purpose === 'documentation' &&
          !['pdf', 'json'].includes(resource.format))
      )
        invalidDescription(
          'Resource format does not match representation purpose',
        );
      used.add(key);
    }
    for (const component of representation.components) {
      if (
        !keys.has(component.resource_key) ||
        Math.abs(Math.hypot(...component.local_origin.quaternion) - 1) > 0.0001
      )
        invalidDescription(
          'Components require a declared resource and a normalized local quaternion',
        );
    }
  }
  if (used.size !== resources.size)
    invalidDescription('Every resource must belong to a representation');
}
export function validateAssetConfiguration(
  version: AssetVersion | undefined,
  configuration: Record<string, unknown>,
) {
  if (
    version &&
    !fieldSchema(version.definition.configuration_schema).safeParse(
      configuration,
    ).success
  )
    throw new PublicFailure(
      400,
      'lab.invalid_input',
      'Configuration does not match the adopted asset version',
    );
}
function canonical(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(canonical);
  if (value && typeof value === 'object')
    return Object.fromEntries(
      Object.entries(value)
        .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
        .map(([key, entry]) => [key, canonical(entry)]),
    );
  return value;
}
export function contentDigest(description: AssetDescription) {
  const resources = description.resources.map((resource) => ({
    key: resource.key,
    format: resource.format,
    sha256: resource.sha256,
    size: resource.size,
  }));
  return createHash('sha256')
    .update(JSON.stringify(canonical({ ...description, resources })))
    .digest('hex');
}
