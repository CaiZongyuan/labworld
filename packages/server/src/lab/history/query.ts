import { sql } from '../../platform/db/index.ts';
/** Bind only placeholders in repository-owned SQL; values never become SQL text. */
export function bindQuery(
  query: string,
  parameters: unknown[],
  types: ReadonlyArray<
    'uuid' | 'text' | 'timestamptz' | 'bigint' | 'jsonb'
  > = [],
) {
  return sql.join(
    query.split(/(\$\d+\b)/).map((part) => {
      if (!/^\$\d+$/.test(part)) return sql.raw(part);
      const index = Number(part.slice(1)) - 1,
        value = sql`${parameters[index]}`;
      return types[index] ? sql`${value}::${sql.raw(types[index])}` : value;
    }),
    sql``,
  );
}
