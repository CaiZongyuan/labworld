import { join } from 'node:path';
import { readFileSync } from 'node:fs';
import { lstat } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { AsyncLocalStorage } from 'node:async_hooks';
import { fileURLToPath } from 'node:url';
import { types, type PGlite, type Transaction } from '@electric-sql/pglite';
import { drizzle, type PgliteDatabase } from 'drizzle-orm/pglite';
import { migrate } from 'drizzle-orm/pglite/migrator';
import { sql } from 'drizzle-orm';
import { MeteredPGlite } from './meter.ts';
import type { DirectoryLease } from './lease.ts';

export type DbSession = Pick<
  PgliteDatabase,
  'select' | 'insert' | 'update' | 'delete' | 'execute'
>;
export type DbOperation = {
  id: string;
  kind: 'request' | 'background' | 'startup';
  budget?: number;
};
export type DbMeasurement = DbOperation & {
  statements: number;
  commands: string[];
  queueWaitMs: number;
  durationMs: number;
  outcome: 'ok' | 'error';
};
export class SqlBudgetExceeded extends Error {}
type OperationScope = {
  measurement: DbMeasurement;
  open: boolean;
  pending: Set<Promise<unknown>>;
};
export const migrationsDirectory = fileURLToPath(
  new URL('../../../migrations/', import.meta.url),
);
const journal = JSON.parse(
  readFileSync(join(migrationsDirectory, 'meta/_journal.json'), 'utf8'),
) as { entries: Array<{ idx: number; when: number; tag: string }> };
export const schemaVersion = journal.entries.at(-1)!.idx + 1;
const expectedMigrations = journal.entries.map((entry) => ({
  when: entry.when,
  hash: createHash('sha256')
    .update(readFileSync(join(migrationsDirectory, `${entry.tag}.sql`), 'utf8'))
    .digest('hex'),
}));

export class Database {
  private client?: MeteredPGlite;
  private directory?: string;
  private tail: Promise<unknown> = Promise.resolve();
  private active?: {
    token: symbol;
    measurement: DbMeasurement;
    owner?: OperationScope;
  };
  private scope = new AsyncLocalStorage<symbol>();
  private operations = new AsyncLocalStorage<OperationScope>();
  private accepting = true;
  private poisoned = false;
  private observe: (measurement: DbMeasurement) => void;
  constructor(
    lease?: DirectoryLease,
    observe: (measurement: DbMeasurement) => void = () => {},
  ) {
    this.directory = lease?.directory;
    this.observe = observe;
  }
  private check(token = this.scope.getStore(), control = false) {
    if (
      !token ||
      token !== this.active?.token ||
      this.scope.getStore() !== token
    )
      throw new Error('Database operation capability has expired');
    // After lease loss only the platform's rollback/close is allowed to finish.
    if (this.poisoned && !control)
      throw new Error('Database lease is unavailable');
    if (this.active?.owner && !this.active.owner.open && !control)
      throw new Error('Database operation scope has expired');
  }
  private enforceBudget(operation: DbOperation, reserved = 0) {
    const active = this.active!;
    const current = active.measurement.statements + reserved;
    if (operation.budget !== undefined && current > operation.budget)
      throw new SqlBudgetExceeded(
        `SQL budget ${operation.budget} exceeded by ${current} statements`,
      );
    const total = current + (active.owner?.measurement.statements ?? 0);
    const budget = active.owner?.measurement.budget;
    if (budget !== undefined && total > budget)
      throw new SqlBudgetExceeded(
        `Whole-operation SQL budget ${budget} exceeded by ${total} statements`,
      );
  }
  private scopedClient<T extends PGlite | Transaction>(
    token: symbol,
    client: T,
  ): T {
    const facade = {
      query: (...args: Parameters<PGlite['query']>) => {
        this.check(token);
        return client.query(...args);
      },
      exec: (...args: Parameters<PGlite['exec']>) => {
        this.check(token);
        return client.exec(...args);
      },
      transaction: <T>(work: (tx: Transaction) => Promise<T>) => {
        this.check(token);
        return (client as PGlite).transaction((tx) =>
          work(this.scopedClient(token, tx)),
        );
      },
    };
    return facade as unknown as T;
  }
  private orm() {
    this.check();
    return drizzle(this.scopedClient(this.active!.token, this.client!));
  }
  private session(orm: PgliteDatabase): DbSession {
    return {
      select: orm.select.bind(orm),
      insert: orm.insert.bind(orm),
      update: orm.update.bind(orm),
      delete: orm.delete.bind(orm),
      execute: orm.execute.bind(orm),
    };
  }
  private enqueue<T>(
    operation: DbOperation,
    work: () => Promise<T>,
  ): Promise<T> {
    if (!this.accepting || this.poisoned)
      return Promise.reject(new Error('Database is unavailable'));
    const inherited = this.operations.getStore();
    if (inherited && !inherited.open)
      return Promise.reject(new Error('Database operation scope has expired'));
    if (inherited && inherited.measurement.kind !== operation.kind)
      return Promise.reject(
        new Error('Database operation kind does not match its active scope'),
      );
    const owner =
      inherited?.measurement.kind === operation.kind ? inherited : undefined;
    if (owner && !owner.open)
      return Promise.reject(new Error('Database operation scope has expired'));
    if (owner && operation.budget !== undefined)
      owner.measurement.budget = Math.min(
        owner.measurement.budget ?? Infinity,
        operation.budget,
      );
    const queued = performance.now();
    const result: Promise<T> = this.tail.then(async () => {
      if (this.poisoned) throw new Error('Database lease is unavailable');
      if (owner && !owner.open)
        throw new Error('Database operation scope has expired');
      const started = performance.now();
      const measurement: DbMeasurement = {
        ...operation,
        statements: 0,
        commands: [],
        queueWaitMs: started - queued,
        durationMs: 0,
        outcome: 'error',
      };
      const token = Symbol(operation.id);
      this.active = { token, measurement, owner };
      return this.scope.run(token, async () => {
        try {
          const value = await work();
          this.enforceBudget(operation);
          measurement.outcome = 'ok';
          return value;
        } finally {
          measurement.durationMs = performance.now() - started;
          this.active = undefined;
          if (owner) {
            owner.measurement.statements += measurement.statements;
            owner.measurement.commands.push(...measurement.commands);
            owner.measurement.queueWaitMs += measurement.queueWaitMs;
            owner.measurement.durationMs += measurement.durationMs;
            if (measurement.outcome === 'error')
              owner.measurement.outcome = 'error';
          } else this.observe(measurement);
        }
      });
    });
    this.tail = result.catch(() => {});
    if (owner) {
      owner.pending.add(result);
      void result.finally(() => owner.pending.delete(result)).catch(() => {});
    }
    return result;
  }
  private async open(migrationFolder?: string) {
    await this.enqueue(
      { id: 'database:migrate', kind: 'startup' },
      async () => {
        if (this.client) throw new Error('Database was already initialized');
        this.client = new MeteredPGlite({
          dataDir: this.directory ? join(this.directory, 'pgdata') : undefined,
          relaxedDurability: false,
          parsers: {
            [types.TIMESTAMP]: (value) => value,
            [types.TIMESTAMPTZ]: (value) => value,
          },
        });
        this.client.beforeProtocol = (message) => {
          // Control messages are recognized at the owned protocol boundary, before dispatch.
          const rollback =
            message[0] === 81 &&
            Buffer.from(message.subarray(5))
              .toString()
              .replace(/\0$/, '')
              .trim()
              .toUpperCase() === 'ROLLBACK';
          this.check(undefined, rollback);
        };
        this.client.onStatement = (command) => {
          this.active!.measurement.statements++;
          this.active!.measurement.commands.push(command);
        };
        await this.client.waitReady;
        if (migrationFolder) {
          const existing = await this.client.query<{ name: string | null }>(
            "select to_regclass('drizzle.__drizzle_migrations')::text as name",
          );
          if (existing.rows[0].name) {
            const history = await this.client.query<{
              hash: string;
              created_at: string;
            }>(
              'select hash,created_at::text from drizzle.__drizzle_migrations order by created_at',
            );
            if (
              history.rows.length > expectedMigrations.length ||
              history.rows.some(
                (entry, index) =>
                  entry.hash !== expectedMigrations[index].hash ||
                  Number(entry.created_at) !== expectedMigrations[index].when,
              )
            )
              throw new Error('Unsupported Node migration history');
          }
          await migrate(this.orm(), { migrationsFolder: migrationFolder });
        }
      },
    );
    if (migrationFolder && !(await this.ready('database:startup-check')))
      throw new Error('Applied migrations do not match this build');
  }
  initialize(migrationFolder = migrationsDirectory) {
    return this.open(migrationFolder);
  }
  async openExisting() {
    if (
      !this.directory ||
      !(await lstat(join(this.directory, 'pgdata'))).isDirectory()
    )
      throw new Error('Existing Node database required');
    await this.open();
  }
  async archiveFacts() {
    const history = await this.readSQL<{ hash: string; created_at: string }>(
      { id: 'database:archive-facts', kind: 'startup', budget: 1 },
      'select hash,created_at::text from drizzle.__drizzle_migrations order by created_at',
    );
    if (
      !history.length ||
      history.length > expectedMigrations.length ||
      history.some(
        (entry, index) =>
          entry.hash !== expectedMigrations[index].hash ||
          Number(entry.created_at) !== expectedMigrations[index].when,
      )
    )
      throw new Error('Unsupported Node migration history');
    const engine = await this.metadata();
    return { schemaVersion: history.length, history, engine: engine[0] };
  }
  read<T>(
    operation: DbOperation,
    work: (session: DbSession) => Promise<T>,
  ): Promise<T> {
    return this.enqueue(operation, () => work(this.session(this.orm())));
  }
  async operation<T>(
    operation: DbOperation,
    work: () => Promise<T>,
  ): Promise<T> {
    const enclosing = this.operations.getStore();
    if (enclosing && !enclosing.open)
      throw new Error('Database operation scope has expired');
    if (enclosing?.open) {
      if (
        enclosing.measurement.id !== operation.id ||
        enclosing.measurement.kind !== operation.kind
      )
        throw new Error(
          'A different database operation scope is already active',
        );
      if (operation.budget !== undefined)
        enclosing.measurement.budget = Math.min(
          enclosing.measurement.budget ?? Infinity,
          operation.budget,
        );
      return work();
    }
    const owner: OperationScope = {
      measurement: {
        ...operation,
        statements: 0,
        commands: [],
        queueWaitMs: 0,
        durationMs: 0,
        outcome: 'ok',
      },
      open: true,
      pending: new Set(),
    };
    return this.operations.run(owner, async () => {
      try {
        const result = await work();
        if (
          owner.measurement.budget !== undefined &&
          owner.measurement.statements > owner.measurement.budget
        )
          throw new SqlBudgetExceeded(
            `Whole-operation SQL budget ${owner.measurement.budget} exceeded`,
          );
        return result;
      } catch (error) {
        owner.measurement.outcome = 'error';
        throw error;
      } finally {
        owner.open = false;
        await Promise.allSettled([...owner.pending]);
        this.observe(owner.measurement);
      }
    });
  }
  transaction<T>(
    operation: DbOperation,
    work: (session: DbSession) => Promise<T>,
  ): Promise<T> {
    return this.enqueue(operation, () =>
      this.orm().transaction(async (tx) => {
        const value = await work(this.session(tx));
        this.enforceBudget(operation, 1);
        return value;
      }),
    );
  }
  readSQL<T>(
    operation: DbOperation,
    query: string,
    parameters: unknown[] = [],
  ): Promise<T[]> {
    return this.enqueue(operation, async () => {
      this.check();
      return (await this.client!.query<T>(query, parameters)).rows;
    });
  }
  script(operation: DbOperation, query: string) {
    return this.enqueue(operation, async () => {
      this.check();
      return this.client!.exec(query);
    });
  }
  async ready(id: string) {
    try {
      return await this.read({ id, kind: 'request', budget: 1 }, async (db) => {
        const result = await db.execute<{ hash: string; created_at: string }>(
          sql`select hash,created_at from drizzle.__drizzle_migrations order by created_at`,
        );
        return (
          result.rows.length === expectedMigrations.length &&
          expectedMigrations.every(
            (entry, index) =>
              result.rows[index].hash === entry.hash &&
              Number(result.rows[index].created_at) === entry.when,
          )
        );
      });
    } catch {
      return false;
    }
  }
  async metadata() {
    return this.readSQL(
      { id: 'database:metadata', kind: 'startup' },
      `select version() as postgres_version,current_setting('fsync') as fsync,current_setting('synchronous_commit') as synchronous_commit`,
    );
  }
  loseLease() {
    this.poisoned = true;
    this.accepting = false;
  }
  async close() {
    this.accepting = false;
    await this.tail;
    if (!this.client || this.client.closed) return;
    const token = Symbol('database:close');
    this.active = {
      token,
      measurement: {
        id: 'database:close',
        kind: 'startup',
        statements: 0,
        commands: [],
        queueWaitMs: 0,
        durationMs: 0,
        outcome: 'ok',
      },
    };
    await this.scope.run(token, async () => {
      this.client!.beforeProtocol = () => this.check(token, true);
      try {
        await this.client!.close();
      } finally {
        this.active = undefined;
      }
    });
  }
}
export { sql } from 'drizzle-orm';
