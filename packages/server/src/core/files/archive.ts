import { sql, type Database } from '../../platform/db/index.ts';
import { files } from './schema.ts';
export type ReadyArchiveFile = {
  id: string;
  key: string;
  size: number;
  sha256: string;
};
/** Bounded metadata reads settle before the caller performs byte I/O. */
export async function* readyArchiveFiles(db: Database) {
  let cursor: string | undefined;
  while (true) {
    const rows = await db.read(
      { id: 'files:archive-references', kind: 'startup', budget: 1 },
      (session) =>
        session.execute<ReadyArchiveFile>(
          sql`select id::text,ready_key as key,actual_size::float8 as size,encode(sha256,'hex') as sha256 from ${files} where state='ready' and ${cursor ? sql`id>${cursor}::uuid` : sql`true`} order by id limit 100`,
        ),
    );
    for (const row of rows.rows) yield row;
    if (rows.rows.length < 100) return;
    cursor = rows.rows.at(-1)!.id;
  }
}
