import { PublicFailure } from './failure.ts';
export function pageQuery(request: Request) {
  const query = new URL(request.url).searchParams;
  if (['limit', 'cursor'].some((field) => query.getAll(field).length > 1))
    throw new PublicFailure(
      400,
      'http.invalid_query',
      'Query parameters are invalid',
    );
  const raw = query.get('limit');
  if (
    raw !== null &&
    (!/^\+?[0-9]+$/.test(raw) ||
      !Number.isSafeInteger(Number(raw)) ||
      Number(raw) > 4294967295)
  )
    throw new PublicFailure(
      400,
      'http.invalid_query',
      'Query parameters are invalid',
    );
  return {
    limit: raw === null ? undefined : Number(raw),
    cursor: query.get('cursor') ?? undefined,
  };
}
