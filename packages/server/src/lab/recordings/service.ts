import { randomBytes, randomUUID } from 'node:crypto';
import { AsyncLocalStorage, AsyncResource } from 'node:async_hooks';
import { readFile } from 'node:fs/promises';
import {
  sql,
  type DbOperation,
  type DbSession,
} from '../../platform/db/index.ts';
import { utcInstant } from '../../platform/db/instant.ts';
import { PublicFailure } from '../../platform/http/failure.ts';
import { accessIn } from '../../core/api-keys/authentication.ts';
import type { FileService } from '../../core/files/use-cases.ts';
import type { WorldService } from '../world/use-cases.ts';
import { loadLab } from '../world/use-cases.ts';
import { worldId } from '../world/entities.ts';
import { commandColumns, commandValue } from '../devices/use-cases.ts';
import type { Session } from '../sessions/dto.ts';
import type { MotionSessionControl } from '../../../../contracts/src/motion/index.ts';
import {
  canonicalSourceHeader,
  recordingLimits,
  mappingDigest,
  sourcePrefixSeed,
  advanceSourcePrefix,
  decodeRecordingPacket,
  decodeFrameBatch,
  parseSourceEvent,
  parseSourceEnd,
  RECORDING_CAPTURE_POLICY,
  RECORDING_CODEC,
  type RecordingAck,
  type RecordingHello,
  type RecordingBootstrap,
  type RecordingReady,
  type RecordingIdentity,
  type RecordingSourceEvent,
  type RecordingLimits,
} from '../../../../contracts/src/recording/index.ts';
import type {
  RecordingSourceAuthority,
  RecordingSourceScope,
  RecordingSourceConnection,
  RecordingBusinessEvent,
  RecordingFaults,
} from './source.ts';
import { waitRecordingFault } from './source.ts';
import {
  DeviceRecordingCapture,
  type CaptureHost,
  type PreparedEventBatch,
} from './capture-plan.ts';
import type { RecordingCaptureScope } from './capture.ts';
import {
  RecordingJournal,
  journalDigest,
  decodeJournalBytes,
  readJournal,
  type JournalSegment,
  type JournalRecord,
} from './journal.ts';
import type { RecordingMetadata } from './dto.ts';

type RecordingRow = {
  id: string;
  session_id: string;
  lab_id: string;
  created_by: string;
  snapshot_hash: string;
  manifest_file_id: string | null;
  manifest_sha256: string | null;
  capture_entity_ids: string[];
  status: RecordingMetadata['status'];
  reason: string | null;
  started_at: string;
  ended_at: string | null;
  event_sequence: string;
  checkpoint: Record<string, unknown>;
  charged_bytes: number;
};
type Boundary = { sequence: string; time: string; sha256: string };
type Owner = {
  row: RecordingRow;
  session: Session;
  journal: RecordingJournal;
  entities: Set<string>;
  prefix: ReturnType<typeof emptyPrefix>;
  eventSequence: bigint;
  identity?: RecordingIdentity;
  headerDigest?: string;
  lastAck?: RecordingAck;
  lastFrame?: Boundary;
  initial?: Boundary;
  transition?: RecordingSourceEvent;
  transitionBoundary?: Boundary;
  connected: boolean;
  resolving?: Promise<void>;
  fault?: string;
  inflight?: {
    digest: string;
    sequence: bigint;
    work: Promise<RecordingAck>;
    settled: Promise<RecordingAck>;
  };
  budget: number;
  budgetAt: number;
  pending: Map<string, PreparedEventBatch>;
  io: Set<Promise<unknown>>;
  cleanup?: Promise<void>;
};
const emptyPrefix = () => ({
  source_packet_sequence: '0',
  source_prefix_sha256: null as string | null,
  last_source_sequence: '0',
  last_source_event_sequence: '0',
  last_sim_time_ns: '0',
  source_ended: false,
});
const fail = (
  code: string,
  message = code,
  status: 400 | 403 | 404 | 409 | 413 | 429 | 503 = 409,
) => new PublicFailure(status, 'lab.' + code, message);
const recordingColumns = sql`id::text,session_id::text,lab_id::text,created_by::text,snapshot_hash,manifest_file_id::text,manifest_sha256,capture_entity_ids,status,reason,started_at,ended_at,event_sequence::text,checkpoint,charged_bytes::float8`;
const publicRow = (
  row: RecordingRow,
  prefix = emptyPrefix(),
): RecordingMetadata => ({
  id: row.id,
  session_id: row.session_id,
  lab_id: row.lab_id,
  snapshot_hash: row.snapshot_hash,
  manifest_sha256: row.manifest_sha256,
  status: row.status,
  reason: row.reason,
  gaps:
    row.status === 'incomplete'
      ? [
          {
            reason: row.reason ?? 'integrity_unconfirmed',
            after_source_sequence: prefix.last_source_sequence,
            after_server_event_sequence: row.event_sequence,
            until: null,
          },
        ]
      : [],
  started_at: utcInstant(row.started_at),
  ended_at: row.ended_at ? utcInstant(row.ended_at) : null,
  integrity:
    row.status === 'complete'
      ? 'complete'
      : row.status === 'open' || row.status === 'preparing'
        ? 'recording'
        : 'incomplete',
  prefix,
  seal: (row.checkpoint.seal as Record<string, unknown>) ?? null,
});
type Receipt = {
  recording_id: string;
  session_id: string;
  snapshot_hash: string;
  manifest_sha256: string;
  ready: true;
};
export type RecordingOptions = {
  maxRecordingBytes: number;
  maxTotalBytes: number;
  maxRetained: number;
  ackMillis: number;
  graceMillis: number;
};
export const defaultRecordingOptions: RecordingOptions = {
  maxRecordingBytes: 1024 * 1024 * 1024,
  maxTotalBytes: 8 * 1024 * 1024 * 1024,
  maxRetained: 64,
  ackMillis: 3000,
  graceMillis: 5000,
};

/** Durable Recording authority; live slots are never read by this module. */
export class RecordingService implements RecordingSourceAuthority, CaptureHost {
  readonly capture: DeviceRecordingCapture;
  readonly limits: RecordingLimits;
  readonly world: WorldService;
  readonly files: FileService;
  readonly directory: string;
  readonly options: RecordingOptions;
  readonly faults: RecordingFaults;
  private owners = new Map<string, Owner>();
  private bySession = new Map<string, string>();
  private tickets = new Map<
    string,
    { scope: RecordingSourceScope; expires: number }
  >();
  private gates = new Map<string, Promise<void>>();
  private held = new AsyncLocalStorage<Set<string>>();
  private preparingLabs = new Map<string, number>();
  private preparingDeadline = new AsyncLocalStorage<number>();
  private gateCounts = new Map<string, number>();
  private charged = 0;
  private stopping = false;
  private recovering = false;
  private resource = new AsyncResource('recording-io-owner');
  private admissionUnavailable?: string;
  private fence: (id: string, reason: string) => void = () => {};
  private control: (id: string) => MotionSessionControl | undefined = () =>
    undefined;
  constructor(
    world: WorldService,
    files: FileService,
    directory: string,
    options: RecordingOptions = defaultRecordingOptions,
    faults: RecordingFaults = {},
  ) {
    this.world = world;
    this.files = files;
    this.directory = directory;
    this.options = options;
    this.faults = faults;
    this.capture = new DeviceRecordingCapture(world.context.db, this);
    this.limits = recordingLimits(options.ackMillis, options.graceMillis);
  }
  configure(
    fence: (id: string, reason: string) => void,
    control: (id: string) => MotionSessionControl | undefined,
  ) {
    this.fence = fence;
    this.control = control;
  }
  hasActiveRecordings() {
    return (
      this.preparingLabs.size > 0 ||
      this.gateCounts.size > 0 ||
      [...this.owners.values()].some(
        (o) => o.io.size > 0 || !!o.cleanup || o.row.status === 'open',
      )
    );
  }
  covers(entity: string) {
    return [...this.owners.values()].some(
      (o) =>
        (o.row.status === 'open' ||
          o.io.size > 0 ||
          !!o.cleanup ||
          this.gateCounts.has(o.row.lab_id)) &&
        o.entities.has(entity),
    );
  }
  private async bounded<T>(
    work: Promise<T>,
    millis: number,
    code: string,
  ): Promise<T> {
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      return await Promise.race([
        work,
        new Promise<T>(
          (_, reject) =>
            (timer = setTimeout(
              () =>
                reject(fail(code, 'Recording operation deadline reached', 503)),
              millis,
            )),
        ),
      ]);
    } finally {
      clearTimeout(timer);
    }
  }
  private actualIO<T>(owner: Owner, work: () => Promise<T>): Promise<T> {
    const actual = this.resource.runInAsyncScope(work);
    owner.io.add(actual);
    void actual.finally(() => owner.io.delete(actual)).catch(() => {});
    return actual;
  }
  private async waitIO<T>(
    owner: Owner,
    actual: Promise<T>,
    code: string,
    millis = this.limits.durability_timeout_ms,
  ) {
    try {
      return await this.bounded(actual, millis, code);
    } catch (error) {
      this.faultSession(owner.session.id, code);
      throw error;
    }
  }
  private io<T>(
    owner: Owner,
    work: () => Promise<T>,
    code: string,
    millis?: number,
  ) {
    return this.waitIO(owner, this.actualIO(owner, work), code, millis);
  }
  private preparationMillis() {
    return Math.max(
      1,
      (this.preparingDeadline.getStore() ?? performance.now() + 10000) -
        performance.now(),
    );
  }
  async gate<T>(labs: string[], work: () => Promise<T>): Promise<T> {
    const held = this.held.getStore() ?? new Set<string>(),
      needed = [...new Set(labs)].filter((l) => !held.has(l)).sort();
    if (!needed.length) return work();
    const releases: Array<() => void> = [];
    try {
      for (const lab of needed) {
        const count = this.gateCounts.get(lab) ?? 0;
        if (count >= 64)
          throw fail(
            'recording_mutation_capacity',
            'Recording mutation capacity reached',
            429,
          );
        this.gateCounts.set(lab, count + 1);
        const previous = this.gates.get(lab) ?? Promise.resolve();
        let release!: () => void;
        const next = new Promise<void>((r) => (release = r));
        this.gates.set(lab, next);
        let freed = false;
        const free = () => {
          if (freed) return;
          freed = true;
          release();
          const remaining = (this.gateCounts.get(lab) ?? 1) - 1;
          if (remaining) this.gateCounts.set(lab, remaining);
          else this.gateCounts.delete(lab);
          if (this.gates.get(lab) === next) this.gates.delete(lab);
        };
        try {
          await this.bounded(previous, 10000, 'recording_gate_timeout');
        } catch (error) {
          void previous.then(free, free);
          throw error;
        }
        releases.push(free);
      }
      return await this.held.run(new Set([...held, ...needed]), work);
    } finally {
      const pending = () =>
        [...this.owners.values()]
          .filter((owner) => needed.includes(owner.session.lab_id))
          .flatMap((owner) => [
            ...owner.io,
            ...(owner.cleanup ? [owner.cleanup] : []),
            ...(owner.resolving ? [owner.resolving] : []),
          ]);
      const release = async () => {
        let work = pending();
        while (work.length) {
          await Promise.allSettled(work);
          work = pending();
        }
        for (const free of releases.reverse()) free();
      };
      void release();
    }
  }
  async preparation<T>(lab: string, work: () => Promise<T>) {
    this.preparingLabs.set(lab, (this.preparingLabs.get(lab) ?? 0) + 1);
    try {
      return await this.preparingDeadline.run(performance.now() + 10000, () =>
        this.gate([lab], work),
      );
    } finally {
      const remaining = this.preparingLabs.get(lab)! - 1;
      if (remaining) this.preparingLabs.set(lab, remaining);
      else this.preparingLabs.delete(lab);
    }
  }
  private checkPreparation() {
    const deadline = this.preparingDeadline.getStore();
    if (deadline !== undefined && performance.now() >= deadline)
      throw fail(
        'recording_prepare_timeout',
        'Recording preparation deadline reached',
        503,
      );
  }
  private async readBarrier(id: string) {
    const owner = this.owners.get(id);
    if (owner && (owner.row.status === 'open' || owner.pending.size > 0))
      await this.bounded(
        this.resolveCommitted(owner),
        this.limits.durability_timeout_ms,
        'recording_read_timeout',
      );
    else if (owner)
      await this.bounded(
        owner.journal.barrier(),
        this.limits.durability_timeout_ms,
        'recording_read_timeout',
      );
  }
  async scope(op: DbOperation, scope: RecordingCaptureScope) {
    let entity = scope.entity,
      lab = scope.lab;
    if (scope.run) {
      const rows = await this.world.context.db.read(op, (tx) =>
        tx.execute<{ entity_id: string; lab_id: string }>(
          sql`select r.entity_id::text,e.lab_id::text from lab.program_runs r join lab.entities e on e.id=r.entity_id where r.id=${worldId(scope.run!)}::uuid`,
        ),
      );
      entity = rows.rows[0]?.entity_id;
      lab = rows.rows[0]?.lab_id;
    }
    if (entity && !lab) {
      const rows = await this.world.context.db.read(op, (tx) =>
        tx.execute<{ lab_id: string }>(
          sql`select lab_id::text from lab.entities where id=${worldId(entity!)}::uuid`,
        ),
      );
      lab = rows.rows[0]?.lab_id;
    }
    if (!lab) return undefined;
    const owner = [...this.owners.values()].find(
      (o) =>
        o.row.lab_id === lab &&
        (o.row.status === 'open' || o.io.size > 0 || !!o.cleanup),
    );
    if (!owner && !this.preparingLabs.has(lab) && !this.gateCounts.has(lab))
      return undefined;
    if (entity && owner && !owner.entities.has(entity)) return undefined;
    return { lab, entities: entity ? [entity] : [...(owner?.entities ?? [])] };
  }
  private operation(kind?: DbOperation['kind']): DbOperation {
    return {
      id: 'recordings:' + randomUUID(),
      kind: kind ?? this.world.context.db.operationKind ?? 'background',
    };
  }
  private now() {
    return utcInstant(this.world.context.clock.now());
  }
  private cursor(
    raw: string,
    id: string,
  ): { recording_id: string; ordinal: string; index: number } {
    try {
      if (raw.length > 2048 || !/^[A-Za-z0-9_-]+$/.test(raw)) throw new Error();
      const value = JSON.parse(Buffer.from(raw, 'base64url').toString('utf8'));
      if (value.recording_id !== id) throw new Error();
      return value;
    } catch {
      throw fail('recording_invalid_cursor', 'Invalid Recording cursor', 400);
    }
  }
  private async rowIn(tx: DbSession, lab: string, id: string) {
    const rows = await tx.execute<RecordingRow>(
      sql`select ${recordingColumns} from lab.recordings where id=${worldId(id)}::uuid and lab_id=${worldId(lab)}::uuid and status<>'deleted'`,
    );
    if (!rows.rows[0])
      throw fail('recording_not_found', 'Recording not found', 404);
    return rows.rows[0];
  }
  private async load(id: string) {
    return this.world.context.db.read(this.operation(), async (tx) => {
      const rows = await tx.execute<RecordingRow>(
        sql`select ${recordingColumns} from lab.recordings where id=${id}::uuid`,
      );
      if (!rows.rows[0])
        throw fail('recording_not_found', 'Recording not found', 404);
      return rows.rows[0];
    });
  }
  private owner(sessionId: string) {
    const id = this.bySession.get(sessionId);
    return id ? this.owners.get(id) : undefined;
  }
  private metadata(row: RecordingRow) {
    const owner = this.owners.get(row.id);
    const projected: RecordingRow =
      owner?.fault && (row.status === 'open' || row.status === 'preparing')
        ? { ...row, status: 'incomplete', reason: owner.fault }
        : row;
    return publicRow(
      projected,
      owner?.prefix ??
        (row.checkpoint.prefix as ReturnType<typeof emptyPrefix>) ??
        emptyPrefix(),
    );
  }
  private createOwner(row: RecordingRow, session: Session) {
    const owner: Owner = {
      row,
      session,
      entities: new Set(row.capture_entity_ids),
      prefix: emptyPrefix(),
      eventSequence: BigInt(row.event_sequence),
      connected: false,
      budget: 60,
      budgetAt: performance.now(),
      pending: new Map(),
      io: new Set(),
      journal: undefined as unknown as RecordingJournal,
    };
    owner.journal = new RecordingJournal(
      this.directory,
      row.id,
      session.id,
      (part, bytes) => this.publishSegment(owner, part, bytes),
      this.faults,
      async (bytes) => {
        if (
          owner.row.charged_bytes + bytes > this.options.maxRecordingBytes ||
          this.charged + bytes > this.options.maxTotalBytes
        )
          throw fail(
            'recording_capacity',
            'Recording disk capacity reached',
            429,
          );
        owner.row.charged_bytes += bytes;
        this.charged += bytes;
      },
      this.limits.durability_timeout_ms,
    );
    this.owners.set(row.id, owner);
    this.bySession.set(session.id, row.id);
    return owner;
  }
  async reserveIn(
    tx: DbSession,
    session: Session,
    actorId: string,
    stagedId?: string,
  ) {
    if (this.admissionUnavailable)
      throw fail('recording_unavailable', this.admissionUnavailable, 503);
    const totals = await tx.execute<{ retained: number; open: number }>(
      sql`select count(*) filter(where r.status<>'deleted')::int as retained,count(*) filter(where r.status in('preparing','open') and s.ended_at is null)::int as open from lab.recordings r join lab.simulation_sessions s on s.id=r.session_id`,
    );
    if (
      totals.rows[0].retained >= this.options.maxRetained ||
      totals.rows[0].open >= 8
    )
      throw fail(
        'recording_capacity',
        'Recording admission capacity reached',
        429,
      );
    const stage = stagedId
      ? (
          await tx.execute<{
            id: string;
            manifest_file_id: string;
            manifest_sha256: string;
            charged_bytes: number;
          }>(
            sql`select id::text,manifest_file_id::text,manifest_sha256,charged_bytes::float8 from lab.recording_stages where id=${stagedId}::uuid and session_id=${session.id}::uuid and lab_id=${session.lab_id}::uuid and created_by=${actorId}::uuid and header_synced`,
          )
        ).rows[0]
      : undefined;
    if (stagedId && (!stage?.manifest_file_id || !stage.manifest_sha256))
      throw fail('recording_stage_not_ready');
    const assets = [
        ...new Map(
          session.snapshot.world.assets.map((a) => [
            a.representation.file_id,
            a.representation,
          ]),
        ).values(),
      ],
      charge = assets.reduce(
        (sum, f) => sum + Number(f.size),
        2 * 1024 * 1024 + 1024 * 1024,
      );
    const sums = await tx.execute<{ bytes: number }>(
      sql`select (coalesce((select sum(charged_bytes) from lab.recordings where status<>'deleted'),0)+coalesce((select sum(charged_bytes) from lab.recording_stages),0))::float8 as bytes`,
    );
    if (
      Number(stage?.charged_bytes ?? charge) > this.options.maxRecordingBytes ||
      Math.max(this.charged, Number(sums.rows[0].bytes)) +
        (stage ? 0 : charge) >
        this.options.maxTotalBytes
    )
      throw fail(
        'recording_capacity',
        'Recording dependency capacity reached',
        429,
      );
    const id = stage?.id ?? randomUUID(),
      rows = await tx.execute<RecordingRow>(
        sql`insert into lab.recordings(id,session_id,lab_id,created_by,snapshot_hash,capture_entity_ids,status,started_at,charged_bytes,manifest_file_id,manifest_sha256) values(${id}::uuid,${session.id}::uuid,${session.lab_id}::uuid,${actorId}::uuid,${session.snapshot.hash},${JSON.stringify(session.snapshot.world.entities.map((e) => e.id))}::jsonb,${stage ? 'open' : 'preparing'},${session.started_at}::timestamptz,${stage ? stage.charged_bytes : charge},${stage?.manifest_file_id ?? null}::uuid,${stage?.manifest_sha256 ?? null}) returning ${recordingColumns}`,
      );
    for (const asset of assets) {
      const file = await this.files.load(tx, asset.file_id);
      if (
        file.state !== 'ready' ||
        file.sha256.toString('hex') !== asset.sha256
      )
        throw fail('recording_dependency_changed');
      await this.files.pin(tx, asset.file_id, {
        ownerType: 'lab.recording',
        ownerId: id,
      });
      await tx.execute(
        sql`insert into lab.recording_resources(recording_id,file_id,role) values(${id}::uuid,${asset.file_id}::uuid,'dependency')`,
      );
    }
    if (stage) {
      await tx.execute(
        sql`update lab.recordings set checkpoint='{"header_synced":true}'::jsonb where id=${id}::uuid`,
      );
      rows.rows[0].checkpoint = { header_synced: true };
      await tx.execute(
        sql`insert into lab.recording_resources(recording_id,file_id,role) values(${id}::uuid,${stage.manifest_file_id}::uuid,'manifest')`,
      );
      await tx.execute(
        sql`delete from lab.recording_stages where id=${id}::uuid`,
      );
    }
    return rows.rows[0];
  }
  async stageSession(session: Session, actorId: string): Promise<Receipt> {
    this.checkPreparation();
    if (this.stopping || this.admissionUnavailable)
      throw fail('recording_unavailable', this.admissionUnavailable, 503);
    const id = randomUUID(),
      now = this.now(),
      entities = session.snapshot.world.entities.map((e) => e.id);
    const baseline = await this.world.context.db.read(
      this.operation(),
      async (tx) => {
        const world = await this.world.snapshotIn(tx, session.lab_id);
        const commands = await tx.execute<
          import('../devices/domain.ts').DeviceCommand
        >(
          sql`select ${commandColumns} from lab.device_commands c where c.entity_id in(select jsonb_array_elements_text(${JSON.stringify(entities)}::jsonb)::uuid) and c.status in('accepted','executing') order by c.created_at,c.id limit 1025`,
        );
        if (commands.rows.length > 1024)
          throw fail('recording_baseline_capacity');
        return {
          recorded_at: now,
          entities: world.entities.filter((e) => entities.includes(e.id)),
          commands: commands.rows.map(commandValue),
        };
      },
    );
    const manifest = {
      format: 'lab-word-recording-manifest-v1',
      recording_id: id,
      session_id: session.id,
      snapshot_hash: session.snapshot.hash,
      snapshot: session.snapshot,
      capture_baseline: baseline,
      capture_entity_ids: entities,
      physics_entity_ids: session.snapshot.installation.targets.map(
        (t) => t.entity_id,
      ),
      versions: { server: '0.1.0', node: process.versions.node, source: null },
    };
    const bytes = Buffer.from(JSON.stringify(manifest)),
      sha = journalDigest(bytes);
    if (bytes.length > 2 * 1024 * 1024)
      throw fail('recording_manifest_capacity');
    const dependencyBytes = [
        ...new Map(
          session.snapshot.world.assets.map((a) => [
            a.representation.file_id,
            a.representation,
          ]),
        ).values(),
      ].reduce((sum, a) => sum + Number(a.size), 0),
      charge = dependencyBytes + bytes.length + 1024 * 1024;
    if (
      charge > this.options.maxRecordingBytes ||
      this.charged + charge > this.options.maxTotalBytes
    )
      throw fail('recording_capacity');
    await this.world.context.db.transaction(this.operation(), async (tx) => {
      const count = await tx.execute<{ n: number }>(
        sql`select count(*)::int as n from lab.recording_stages`,
      );
      if (count.rows[0].n >= 8) throw fail('recording_stage_capacity');
      await tx.execute(
        sql`insert into lab.recording_stages(id,session_id,lab_id,created_by,charged_bytes,created_at) values(${id}::uuid,${session.id}::uuid,${session.lab_id}::uuid,${actorId}::uuid,${charge},${now}::timestamptz)`,
      );
    });
    const row: RecordingRow = {
      id,
      session_id: session.id,
      lab_id: session.lab_id,
      created_by: actorId,
      snapshot_hash: session.snapshot.hash,
      manifest_file_id: null,
      manifest_sha256: null,
      capture_entity_ids: entities,
      status: 'preparing',
      reason: null,
      started_at: session.started_at,
      ended_at: null,
      event_sequence: '0',
      checkpoint: {},
      charged_bytes: charge,
    };
    this.charged += charge;
    const owner = this.createOwner(row, session);
    try {
      await this.io(
        owner,
        () => owner.journal.initialize(),
        'recording_prepare_timeout',
        this.preparationMillis(),
      );
      await this.io(
        owner,
        () =>
          this.files.publishManaged(
            this.operation(),
            actorId,
            {
              file_name: 'recording-manifest.json',
              content_type: 'application/json',
              bytes,
            },
            { ownerType: 'lab.recording', ownerId: id },
            async (tx, file) => {
              await tx.execute(
                sql`update lab.recording_stages set manifest_file_id=${file.id}::uuid,manifest_sha256=${sha} where id=${id}::uuid`,
              );
              owner.row.manifest_file_id = file.id;
              owner.row.manifest_sha256 = sha;
            },
          ),
        'recording_prepare_timeout',
        this.preparationMillis(),
      );
      this.checkPreparation();
      await this.io(
        owner,
        () =>
          owner.journal.append(
            'header',
            {
              format: 'lab-word-recording-journal-v1',
              recording_id: id,
              session_id: session.id,
              manifest_sha256: sha,
              snapshot_hash: session.snapshot.hash,
              staged: true,
            },
            now,
          ),
        'recording_prepare_timeout',
        this.preparationMillis(),
      );
      this.checkPreparation();
      await this.world.context.db.transaction(this.operation(), (tx) =>
        tx.execute(
          sql`update lab.recording_stages set header_synced=true,charged_bytes=${owner.row.charged_bytes} where id=${id}::uuid`,
        ),
      );
      return {
        recording_id: id,
        session_id: session.id,
        snapshot_hash: session.snapshot.hash,
        manifest_sha256: sha,
        ready: true,
      };
    } catch (error) {
      await this.abortStage(id);
      throw error;
    }
  }
  async attachStage(receipt: Receipt, session: Session) {
    const owner = this.owners.get(receipt.recording_id);
    if (
      !owner ||
      owner.session.id !== session.id ||
      owner.row.manifest_sha256 !== receipt.manifest_sha256
    )
      throw fail('recording_stage_changed');
    const row = await this.load(receipt.recording_id);
    if (
      row.status !== 'open' ||
      row.session_id !== session.id ||
      row.manifest_sha256 !== receipt.manifest_sha256
    )
      throw fail('recording_stage_changed');
    owner.row = row;
    owner.session = session;
    await this.io(
      owner,
      () =>
        owner.journal.append(
          'business.event',
          {
            event_id: randomUUID(),
            event_type: 'session.changed',
            entity_id: null,
            recorded_at: this.now(),
            sim_time_ns: null,
            event: {
              session_id: session.id,
              status: session.status,
              revision: session.revision,
              started_at: session.started_at,
            },
          },
          this.now(),
        ),
      'recording_event_commit_timeout',
    );
  }
  async abortStage(id: string) {
    const owner = this.owners.get(id);
    if (owner?.io.size) {
      if (!owner.cleanup) {
        owner.cleanup = this.resource
          .runInAsyncScope(async () => {
            await Promise.allSettled([...owner.io]);
            await this.abortStage(id);
          })
          .finally(() => {
            owner.cleanup = undefined;
          });
        void owner.cleanup.catch(() => {
          this.admissionUnavailable = 'Recording stage cleanup failed';
        });
      }
      return;
    }
    const stage = await this.world.context.db.read(this.operation(), (tx) =>
      tx.execute<{ session_id: string; charged_bytes: number }>(
        sql`select session_id::text,charged_bytes::float8 from lab.recording_stages where id=${id}::uuid`,
      ),
    );
    if (!stage.rows[0]) return;
    const existing = await this.world.context.db.read(this.operation(), (tx) =>
      tx.execute(sql`select id from lab.recordings where id=${id}::uuid`),
    );
    if (existing.rows.length) throw fail('recording_stage_adopted');
    if (owner) await owner.journal.remove();
    else {
      const abandoned = new RecordingJournal(
        this.directory,
        id,
        stage.rows[0].session_id,
        async () => {},
      );
      await abandoned.initialize();
      await abandoned.remove();
    }
    await this.world.context.db.transaction(this.operation(), async (tx) => {
      const adopted = await tx.execute(
        sql`select id from lab.recordings where id=${id}::uuid`,
      );
      if (adopted.rows.length) throw fail('recording_stage_adopted');
      const refs = await tx.execute<{ file_id: string }>(
        sql`select file_id::text from labos_threejs_core.file_references where owner_type='lab.recording' and owner_id=${id}`,
      );
      await tx.execute(
        sql`delete from lab.recording_stages where id=${id}::uuid`,
      );
      for (const ref of refs.rows) {
        await this.files.release(tx, ref.file_id, {
          ownerType: 'lab.recording',
          ownerId: id,
        });
        await this.files.dispose(tx, ref.file_id);
      }
    });
    this.charged -= Number(
      owner?.row.charged_bytes ?? stage.rows[0].charged_bytes,
    );
    this.owners.delete(id);
    this.bySession.delete(stage.rows[0].session_id);
  }
  private async publishSegment(
    owner: Owner,
    part: JournalSegment,
    bytes: Uint8Array,
  ) {
    const committed = decodeJournalBytes(bytes)
      .filter(
        (record) =>
          record.kind === 'business.commit' &&
          Array.isArray(record.data.events) &&
          journalDigest(Buffer.from(JSON.stringify(record.data.events))) ===
            record.data.sha256,
      )
      .map((record) => String(record.data.batch_id));
    const existing = await this.world.context.db.read(this.operation(), (tx) =>
      tx.execute<{ sha256: string; size: number }>(
        sql`select sha256,size from lab.recording_segments where recording_id=${owner.row.id}::uuid and index=${part.index}`,
      ),
    );
    if (existing.rows[0]) {
      if (
        existing.rows[0].sha256 !== part.sha256 ||
        Number(existing.rows[0].size) !== bytes.byteLength
      )
        throw fail('recording_segment_changed');
      for (const id of committed) owner.pending.delete(id);
      return;
    }
    if (
      owner.row.charged_bytes + bytes.length > this.options.maxRecordingBytes ||
      this.charged + bytes.length > this.options.maxTotalBytes
    )
      throw fail(
        'recording_capacity',
        'Segment publication capacity reached',
        429,
      );
    await waitRecordingFault(
      this.faults.beforePublish?.(owner.row.id, part.id),
      this.limits.durability_timeout_ms,
    );
    await this.files.publishManaged(
      this.operation(),
      owner.row.created_by,
      {
        file_name: `recording-${part.index}.lwf`,
        content_type: 'application/vnd.lab-word.recording-segment',
        bytes,
      },
      { ownerType: 'lab.recording', ownerId: owner.row.id },
      async (tx, file) => {
        await tx.execute(
          sql`insert into lab.recording_resources(recording_id,file_id,role) values(${owner.row.id}::uuid,${file.id}::uuid,'segment')`,
        );
        await tx.execute(
          sql`insert into lab.recording_segments(id,recording_id,index,file_id,size,sha256,first_ordinal,last_ordinal) values(${part.id}::uuid,${owner.row.id}::uuid,${part.index},${file.id}::uuid,${file.size},${part.sha256},${part.first_ordinal}::numeric,${part.last_ordinal}::numeric)`,
        );
        const charged = owner.row.charged_bytes + bytes.length;
        await tx.execute(
          sql`update lab.recordings set charged_bytes=${charged},checkpoint=${JSON.stringify({ ...owner.row.checkpoint, prefix: owner.prefix })}::jsonb where id=${owner.row.id}::uuid`,
        );
        if (committed.length)
          await tx.execute(
            sql`delete from lab.recording_event_commits where recording_id=${owner.row.id}::uuid and batch_id in(select jsonb_array_elements_text(${JSON.stringify(committed)}::jsonb)::uuid)`,
          );
      },
    );
    owner.row.charged_bytes += bytes.length;
    this.charged += bytes.length;
    for (const id of committed) owner.pending.delete(id);
  }
  async prepareSession(
    session: Session,
    actorId: string,
    baseline?: Record<string, unknown>,
  ): Promise<Receipt> {
    this.checkPreparation();
    if (this.stopping || this.admissionUnavailable)
      throw fail('recording_unavailable', 'Recording owner is stopping', 503);
    const previous = this.owner(session.id);
    if (previous) {
      await this.prepare(session.id, session.snapshot.hash);
      return {
        recording_id: previous.row.id,
        session_id: session.id,
        snapshot_hash: session.snapshot.hash,
        manifest_sha256: previous.row.manifest_sha256!,
        ready: true,
      };
    }
    const reserved = await this.world.context.db.read(this.operation(), (tx) =>
      tx.execute<RecordingRow>(
        sql`select ${recordingColumns} from lab.recordings where session_id=${session.id}::uuid`,
      ),
    );
    const preReserved = reserved.rows[0];
    const id = preReserved?.id ?? randomUUID(),
      now = this.now();
    const entityIds = session.snapshot.world.entities.map((e) => e.id);
    const current =
      baseline ??
      (await this.world.context.db.read(this.operation(), async (tx) => {
        const world = await this.world.snapshotIn(tx, session.lab_id);
        const commands = await tx.execute<
          import('../devices/domain.ts').DeviceCommand
        >(
          sql`select ${commandColumns} from lab.device_commands c where c.entity_id in(select jsonb_array_elements_text(${JSON.stringify(entityIds)}::jsonb)::uuid) and c.status in('accepted','executing') order by c.created_at,c.id limit 1025`,
        );
        if (commands.rows.length > 1024)
          throw fail('recording_baseline_capacity');
        return {
          recorded_at: now,
          entities: world.entities.filter((e) => entityIds.includes(e.id)),
          commands: commands.rows.map(commandValue),
        };
      }));
    const manifest = {
      format: 'lab-word-recording-manifest-v1',
      recording_id: id,
      session_id: session.id,
      snapshot_hash: session.snapshot.hash,
      snapshot: session.snapshot,
      capture_baseline: current,
      capture_entity_ids: entityIds,
      physics_entity_ids: session.snapshot.installation.targets.map(
        (t) => t.entity_id,
      ),
      versions: { server: '0.1.0', node: process.versions.node, source: null },
    };
    const bytes = Buffer.from(JSON.stringify(manifest));
    if (bytes.length > 2 * 1024 * 1024)
      throw fail(
        'recording_manifest_capacity',
        'Recording manifest exceeds capacity',
        413,
      );
    const row =
      preReserved ??
      (await this.world.context.db.transaction(this.operation(), async (tx) => {
        const totals = await tx.execute<{ retained: number; open: number }>(
          sql`select count(*) filter(where status<>'deleted')::int as retained,count(*) filter(where status in('preparing','open'))::int as open from lab.recordings`,
        );
        if (
          totals.rows[0].retained >= this.options.maxRetained ||
          totals.rows[0].open >= 8
        )
          throw fail(
            'recording_capacity',
            'Recording admission capacity reached',
            429,
          );
        const files = [
          ...new Map(
            session.snapshot.world.assets.map((a) => [
              a.representation.file_id,
              a.representation,
            ]),
          ).values(),
        ];
        const charge = files.reduce(
          (sum, f) => sum + Number(f.size),
          bytes.length,
        );
        if (
          charge > this.options.maxRecordingBytes ||
          this.charged + charge > this.options.maxTotalBytes
        )
          throw fail(
            'recording_capacity',
            'Recording dependency capacity reached',
            429,
          );
        const result = await tx.execute<RecordingRow>(
          sql`insert into lab.recordings(id,session_id,lab_id,created_by,snapshot_hash,capture_entity_ids,status,started_at,charged_bytes) values(${id}::uuid,${session.id}::uuid,${session.lab_id}::uuid,${actorId}::uuid,${session.snapshot.hash},${JSON.stringify(entityIds)}::jsonb,'preparing',${now}::timestamptz,${charge}) returning ${recordingColumns}`,
        );
        for (const file of files) {
          const ready = await this.files.load(tx, file.file_id);
          if (
            ready.state !== 'ready' ||
            ready.sha256.toString('hex') !== file.sha256
          )
            throw fail('recording_dependency_changed');
          await this.files.pin(tx, file.file_id, {
            ownerType: 'lab.recording',
            ownerId: id,
          });
          await tx.execute(
            sql`insert into lab.recording_resources(recording_id,file_id,role) values(${id}::uuid,${file.file_id}::uuid,'dependency')`,
          );
        }
        return result.rows[0];
      }));
    this.charged += Number(row.charged_bytes);
    const owner = this.createOwner(row, session);
    try {
      await this.io(
        owner,
        () => owner.journal.initialize(),
        'recording_prepare_timeout',
        this.preparationMillis(),
      );
      const sha = journalDigest(bytes);
      await this.io(
        owner,
        () =>
          this.files.publishManaged(
            this.operation(),
            actorId,
            {
              file_name: 'recording-manifest.json',
              content_type: 'application/json',
              bytes,
            },
            { ownerType: 'lab.recording', ownerId: id },
            async (tx, file) => {
              await tx.execute(
                sql`insert into lab.recording_resources(recording_id,file_id,role) values(${id}::uuid,${file.id}::uuid,'manifest')`,
              );
              await tx.execute(
                sql`update lab.recordings set manifest_file_id=${file.id}::uuid,manifest_sha256=${sha} where id=${id}::uuid`,
              );
              owner.row.manifest_file_id = file.id;
              owner.row.manifest_sha256 = sha;
            },
          ),
        'recording_prepare_timeout',
        this.preparationMillis(),
      );
      this.checkPreparation();
      await this.io(
        owner,
        () =>
          owner.journal.append(
            'header',
            {
              format: 'lab-word-recording-journal-v1',
              recording_id: id,
              session_id: session.id,
              manifest_sha256: sha,
              snapshot_hash: session.snapshot.hash,
            },
            now,
          ),
        'recording_prepare_timeout',
        this.preparationMillis(),
      );
      await this.io(
        owner,
        () =>
          owner.journal.append(
            'business.event',
            {
              event_id: randomUUID(),
              event_type: 'session.changed',
              entity_id: null,
              recorded_at: now,
              sim_time_ns: null,
              event: {
                session_id: session.id,
                status: session.status,
                revision: session.revision,
                started_at: session.started_at,
              },
            },
            now,
          ),
        'recording_prepare_timeout',
        this.preparationMillis(),
      );
      this.checkPreparation();
      await this.world.context.db.transaction(this.operation(), (tx) =>
        tx.execute(
          sql`update lab.recordings set status='open',checkpoint='{"header_synced":true}'::jsonb where id=${id}::uuid and status='preparing'`,
        ),
      );
      owner.row.status = 'open';
      owner.row.checkpoint = { header_synced: true };
      return {
        recording_id: id,
        session_id: session.id,
        snapshot_hash: session.snapshot.hash,
        manifest_sha256: sha,
        ready: true,
      };
    } catch (error) {
      owner.fault = 'recording_prepare_failed';
      await this.world.context.db.transaction(this.operation(), (tx) =>
        tx.execute(
          sql`update lab.recordings set status='incomplete',reason='recording_prepare_failed',ended_at=${this.now()}::timestamptz,charged_bytes=${owner.row.charged_bytes} where id=${id}::uuid`,
        ),
      );
      owner.row.status = 'incomplete';
      owner.row.reason = 'recording_prepare_failed';
      owner.row.ended_at = this.now();
      throw error;
    }
  }
  async compensatePreparation(
    session: Session,
    reason = 'recording_prepare_failed',
  ) {
    // The reservation already adopted every exact dependency in the same
    // transaction as the Session. Release its redundant custody even when no
    // manifest/header could be prepared; the Recording remains honestly empty.
    await this.world.context.db.transaction(this.operation(), async (tx) => {
      const row = await tx.execute<{ id: string }>(
        sql`select id::text from lab.recordings where session_id=${session.id}::uuid`,
      );
      if (!row.rows[0]) return;
      for (const asset of session.snapshot.world.assets) {
        const refs = await tx.execute(
          sql`select 1 from lab.recording_resources r join labos_threejs_core.file_references f on f.file_id=r.file_id and f.owner_type='lab.recording' and f.owner_id=r.recording_id::text where r.recording_id=${row.rows[0].id}::uuid and r.file_id=${asset.representation.file_id}::uuid and r.role='dependency'`,
        );
        if (!refs.rows.length) throw fail('recording_dependency_not_adopted');
      }
      await tx.execute(
        sql`update lab.recordings set status='incomplete',reason=${reason},ended_at=${this.now()}::timestamptz where id=${row.rows[0].id}::uuid`,
      );
      await tx.execute(
        sql`delete from lab.session_assets where session_id=${session.id}::uuid and exists(select 1 from lab.simulation_sessions s where s.id=${session.id}::uuid and s.ended_at is not null)`,
      );
    });
    const owner = this.owner(session.id);
    if (owner) {
      owner.session = session;
      owner.fault = reason;
      owner.row.status = 'incomplete';
      owner.row.reason = reason;
      owner.row.ended_at = this.now();
    }
  }
  async bootstrap(
    session: Session,
    motionTickets = 0,
  ): Promise<RecordingBootstrap> {
    const owner = this.owner(session.id);
    if (
      !owner?.row.manifest_sha256 ||
      owner.row.status !== 'open' ||
      !!owner.fault ||
      owner.row.checkpoint.header_synced !== true
    )
      throw fail('recording_not_ready');
    for (const [key, t] of this.tickets)
      if (t.expires <= performance.now()) this.tickets.delete(key);
    if (this.tickets.size + motionTickets >= 256)
      throw fail(
        'recording_ticket_capacity',
        'Recording ticket capacity reached',
        429,
      );
    const ticket = 'r_' + randomBytes(32).toString('base64url');
    const i = session.snapshot.installation;
    const bootstrap: RecordingBootstrap = {
      recording_id: owner.row.id,
      session_id: session.id,
      lease_id: session.lease_id!,
      epoch: session.epoch!,
      snapshot_hash: session.snapshot.hash,
      manifest_sha256: owner.row.manifest_sha256,
      scene_hash: i.scene_hash,
      mapping_revision: i.mapping_revision,
      mapping_sha256: await mappingDigest(i),
      websocket_path: `/api/v1/lab/recordings/${owner.row.id}/source`,
      ticket,
      expires_in_seconds: 30,
      capture_policy: RECORDING_CAPTURE_POLICY,
      limits: this.limits,
    };
    const identity: RecordingSourceScope['bootstrap'] = {
      recording_id: bootstrap.recording_id,
      session_id: bootstrap.session_id,
      lease_id: bootstrap.lease_id,
      epoch: bootstrap.epoch,
      snapshot_hash: bootstrap.snapshot_hash,
      manifest_sha256: bootstrap.manifest_sha256,
      scene_hash: bootstrap.scene_hash,
      mapping_revision: bootstrap.mapping_revision,
      mapping_sha256: bootstrap.mapping_sha256,
      capture_policy: bootstrap.capture_policy,
      limits: bootstrap.limits,
    };
    this.tickets.set(ticket, {
      scope: { bootstrap: identity, session },
      expires: performance.now() + 30000,
    });
    return bootstrap;
  }
  get ticketCount() {
    return this.tickets.size;
  }
  async consume(ticket: string, recordingId: string) {
    const entry = this.tickets.get(ticket);
    this.tickets.delete(ticket);
    if (
      !entry ||
      entry.expires <= performance.now() ||
      entry.scope.bootstrap.recording_id !== recordingId ||
      this.stopping
    )
      throw fail('recording_unauthorized', 'Recording admission failed', 403);
    const b = entry.scope.bootstrap;
    await this.world.context.db.read(this.operation('request'), async (tx) => {
      const valid = await tx.execute(
        sql`select s.id from lab.simulation_sessions s join lab.publisher_leases l on l.id=s.lease_id join labos_threejs_core.machines m on m.id=l.machine_id join lab.recordings r on r.session_id=s.id where s.id=${b.session_id}::uuid and s.ended_at is null and s.epoch=${b.epoch}::numeric and l.id=${b.lease_id}::uuid and l.ended_at is null and m.revoked_at is null and m.expires_at>${this.now()}::timestamptz and r.id=${recordingId}::uuid and r.status='open' and r.snapshot_hash=${b.snapshot_hash}`,
      );
      if (!valid.rows.length)
        throw fail('recording_unauthorized', 'Recording lease has ended', 403);
    });
    return entry.scope;
  }
  async bind(
    scope: RecordingSourceScope,
    hello: RecordingHello,
  ): Promise<RecordingSourceConnection> {
    const owner = this.owners.get(scope.bootstrap.recording_id),
      identity = scope.bootstrap;
    if (!owner || owner.connected || owner.fault || owner.row.status !== 'open')
      throw fail('recording_source_conflict');
    if (
      [
        'recording_id',
        'session_id',
        'lease_id',
        'epoch',
        'snapshot_hash',
        'manifest_sha256',
        'scene_hash',
        'mapping_revision',
        'mapping_sha256',
      ].some(
        (k) =>
          hello[k as keyof RecordingIdentity] !==
          identity[k as keyof RecordingIdentity],
      ) ||
      hello.source_header.source_kind !== 'synthetic'
    )
      throw fail('recording_scope_mismatch');
    const headerBytes = canonicalSourceHeader(hello.source_header),
      headerDigest = journalDigest(headerBytes);
    owner.identity = identity;
    owner.headerDigest = headerDigest;
    const prefix = await sourcePrefixSeed(identity, headerDigest);
    await this.io(
      owner,
      () =>
        owner.journal.append(
          'source.header',
          {
            identity,
            source_header: hello.source_header,
            source_header_sha256: headerDigest,
            source_prefix_sha256: prefix,
          },
          this.now(),
        ),
      'recording_ack_timeout',
    );
    owner.prefix.source_prefix_sha256 = prefix;
    if (owner.fault || owner.row.status !== 'open' || this.stopping)
      throw fail('recording_closed');
    owner.connected = true;
    const ready: RecordingReady = {
      ...identity,
      type: 'recording.ready',
      version: 1,
      codec: RECORDING_CODEC,
      source_header_sha256: headerDigest,
      source_prefix_sha256: prefix,
      capture_policy: RECORDING_CAPTURE_POLICY,
      limits: this.limits,
    };
    return {
      ready,
      receive: (raw) => this.receive(owner, raw),
      leave: (reason) => {
        owner.connected = false;
        if (!owner.prefix.source_ended && owner.row.status === 'open')
          this.fault(scope, reason);
      },
    };
  }
  fault(scope: RecordingSourceScope, reason: string) {
    const owner = this.owners.get(scope.bootstrap.recording_id);
    if (
      !owner ||
      owner.session.id !== scope.bootstrap.session_id ||
      owner.fault
    )
      return;
    owner.fault = reason;
    this.fence(owner.session.id, reason);
  }
  faultSession(sessionId: string, reason: string) {
    const owner = this.owner(sessionId);
    if (!owner || owner.fault) return;
    owner.fault = reason;
    this.fence(sessionId, reason);
  }
  private async receive(owner: Owner, raw: Uint8Array): Promise<RecordingAck> {
    if (
      this.stopping ||
      owner.fault ||
      owner.row.status !== 'open' ||
      !owner.identity
    )
      throw fail('recording_closed');
    const packet = await decodeRecordingPacket(raw, owner.identity);
    if (this.stopping || owner.fault || owner.row.status !== 'open')
      throw fail('recording_closed');
    if (
      owner.lastAck &&
      packet.source_packet_sequence ===
        BigInt(owner.lastAck.source_packet_sequence)
    ) {
      if (packet.packet_sha256 !== owner.lastAck.packet_sha256)
        throw fail('recording_altered_duplicate');
      return owner.lastAck;
    }
    if (
      owner.inflight &&
      packet.source_packet_sequence === owner.inflight.sequence
    ) {
      if (packet.packet_sha256 !== owner.inflight.digest)
        throw fail('recording_altered_duplicate');
      return owner.inflight.work;
    }
    if (
      packet.source_packet_sequence !==
        BigInt(owner.prefix.source_packet_sequence) + 1n ||
      owner.inflight
    )
      throw fail('recording_sequence_gap');
    let timer: ReturnType<typeof setTimeout> | undefined;
    const timeout = new Promise<RecordingAck>((_, reject) => {
      timer = setTimeout(
        () => reject(fail('recording_ack_timeout')),
        this.limits.durability_timeout_ms,
      );
    });
    const settled = this.receiveNext(owner, packet, raw);
    const work = Promise.race([settled, timeout]).catch((error) => {
      this.faultSession(
        owner.session.id,
        error instanceof Error ? error.message : 'write_failed',
      );
      throw error;
    });
    owner.inflight = {
      digest: packet.packet_sha256,
      sequence: packet.source_packet_sequence,
      work,
      settled,
    };
    const inflight = owner.inflight;
    void settled
      .finally(() => {
        clearTimeout(timer);
        if (owner.inflight === inflight) owner.inflight = undefined;
      })
      .catch(() => {});
    return work;
  }
  private async receiveNext(
    owner: Owner,
    packet: Awaited<ReturnType<typeof decodeRecordingPacket>>,
    raw: Uint8Array,
  ): Promise<RecordingAck> {
    if (owner.prefix.source_ended) throw fail('recording_source_ended');
    let last = owner.lastFrame,
      initial = owner.initial,
      event = owner.transition,
      sourceSequence = BigInt(owner.prefix.last_source_sequence),
      eventSequence = BigInt(owner.prefix.last_source_event_sequence),
      ended = false;
    if (packet.kind === 1) {
      const i = owner.session.snapshot.installation,
        frames = decodeFrameBatch(packet.payload, {
          epoch: BigInt(owner.identity!.epoch),
          mapping_revision: i.mapping_revision,
          body_count: i.pose_keys.length,
          joint_count: i.joint_keys.length,
        });
      if (frames.first_source_sequence !== sourceSequence + 1n)
        throw fail('recording_sequence_gap');
      const now = performance.now();
      owner.budget = Math.min(60, owner.budget + (now - owner.budgetAt) * 0.03);
      owner.budgetAt = now;
      if (frames.frames.length > owner.budget)
        throw fail('recording_source_rate');
      owner.budget -= frames.frames.length;
      for (const frame of frames.frames) {
        if (last && frame.snapshot.sim_time_ns < BigInt(last.time))
          throw fail('recording_time_rollback');
        if (!initial) {
          const expected = owner.session.snapshot;
          const equal = (a: number, b: number) =>
            Math.abs(a - b) <= Math.max(0.00001, Math.abs(b) * 0.000001);
          if (
            frame.snapshot.sequence !== 1n ||
            frame.snapshot.sim_time_ns !== 0n ||
            frame.snapshot.poses.some(
              (p, n) =>
                p.position.some(
                  (v, a) => !equal(v, expected.initial_poses[n].position[a]),
                ) ||
                p.quaternion.some(
                  (v, a) => !equal(v, expected.initial_poses[n].quaternion[a]),
                ),
            ) ||
            frame.snapshot.joints.some(
              (v, n) => !equal(v, expected.initial_joints[n]),
            )
          )
            throw fail('recording_initial_state_rejected');
        }
        last = {
          sequence: String(frame.snapshot.sequence),
          time: String(frame.snapshot.sim_time_ns),
          sha256: journalDigest(frame.bytes),
        };
        initial ??= last;
        sourceSequence = frame.snapshot.sequence;
      }
    } else if (packet.kind === 2) {
      event = parseSourceEvent(
        new TextDecoder('utf-8', { fatal: true }).decode(packet.payload),
      );
      const control = this.control(owner.session.id);
      if (
        !control ||
        event.source_event_sequence !== String(eventSequence + 1n) ||
        event.subject.session_id !== owner.session.id ||
        event.event.transition_id !== control.transition_id ||
        event.event.revision !== control.revision ||
        event.event.action !== control.action ||
        event.event.boundary_source_sequence !== last?.sequence ||
        event.sim_time_ns !== last?.time
      )
        throw fail('recording_lifecycle_event_rejected');
      eventSequence++;
    } else {
      const end = parseSourceEnd(
        new TextDecoder('utf-8', { fatal: true }).decode(packet.payload),
      );
      if (
        !event ||
        event.event.action !== 'stop' ||
        end.transition_id !== event.event.transition_id ||
        end.revision !== event.event.revision ||
        end.last_source_sequence !== String(sourceSequence) ||
        end.last_source_event_sequence !== String(eventSequence) ||
        end.sim_time_ns !== last?.time
      )
        throw fail('recording_source_end_rejected');
      ended = true;
    }
    const prefix = await advanceSourcePrefix(
      owner.prefix.source_prefix_sha256!,
      packet.packet_sha256,
    );
    if (owner.fault || owner.row.status !== 'open')
      throw fail('recording_closed');
    await this.io(
      owner,
      () =>
        owner.journal.append(
          'source.packet',
          {
            packet_base64: Buffer.from(raw).toString('base64'),
            source_packet_sequence: String(packet.source_packet_sequence),
            packet_sha256: packet.packet_sha256,
            source_prefix_sha256: prefix,
          },
          this.now(),
        ),
      'recording_ack_timeout',
    );
    owner.lastFrame = last;
    owner.initial = initial;
    owner.transition = event;
    if (packet.kind === 2) owner.transitionBoundary = last;
    owner.prefix = {
      source_packet_sequence: String(packet.source_packet_sequence),
      source_prefix_sha256: prefix,
      last_source_sequence: String(sourceSequence),
      last_source_event_sequence: String(eventSequence),
      last_sim_time_ns: last?.time ?? '0',
      source_ended: ended,
    };
    if (owner.fault || owner.row.status !== 'open')
      throw fail('recording_closed');
    const ack: RecordingAck = {
      type: 'recording.ack',
      version: 1,
      recording_id: owner.row.id,
      session_id: owner.session.id,
      lease_id: owner.identity!.lease_id,
      epoch: owner.identity!.epoch,
      source_packet_sequence: owner.prefix.source_packet_sequence,
      packet_sha256: packet.packet_sha256,
      source_prefix_sha256: prefix,
      durable_source_sequence: String(sourceSequence),
      durable_source_event_sequence: String(eventSequence),
      source_ended: ended,
    };
    owner.lastAck = ack;
    return ack;
  }
  initialMatches(
    sessionId: string,
    sequence: bigint,
    time: bigint,
    digest: string,
  ) {
    const value = this.owner(sessionId)?.initial;
    return (
      !!value &&
      value.sequence === String(sequence) &&
      value.time === String(time) &&
      value.sha256 === digest
    );
  }
  boundaryMatches(
    sessionId: string,
    control: MotionSessionControl,
    sequence: bigint,
    time: bigint,
    digest: string,
  ) {
    const owner = this.owner(sessionId),
      event = owner?.transition,
      last = owner?.transitionBoundary;
    return (
      !!owner &&
      !owner.fault &&
      !!event &&
      event.event.transition_id === control.transition_id &&
      event.event.revision === control.revision &&
      event.event.action === control.action &&
      last?.sequence === String(sequence) &&
      last.time === String(time) &&
      last.sha256 === digest &&
      event.event.boundary_source_sequence === String(sequence) &&
      (control.action !== 'stop' || owner.prefix.source_ended)
    );
  }
  boundaryFor(sessionId: string, control: MotionSessionControl) {
    const owner = this.owner(sessionId);
    return owner?.transition?.event.transition_id === control.transition_id &&
      owner.transitionBoundary
      ? { ...owner.transitionBoundary }
      : undefined;
  }
  async prepare(
    events: RecordingBusinessEvent[],
  ): Promise<PreparedEventBatch[]>;
  async prepare(sessionId: string, snapshotHash: string): Promise<void>;
  async prepare(
    input: RecordingBusinessEvent[] | string,
    snapshotHash?: string,
  ): Promise<PreparedEventBatch[] | void> {
    if (typeof input === 'string') {
      const owner = this.owner(input);
      this.checkPreparation();
      if (
        !owner ||
        owner.row.status !== 'open' ||
        !!owner.fault ||
        owner.row.snapshot_hash !== snapshotHash ||
        !owner.row.manifest_sha256 ||
        owner.row.checkpoint.header_synced !== true
      )
        throw fail('recording_not_ready');
      await this.waitIO(
        owner,
        owner.journal.barrier(),
        'recording_prepare_timeout',
        this.preparationMillis(),
      );
      return;
    }
    const result: PreparedEventBatch[] = [];
    for (const owner of this.owners.values()) {
      if (owner.row.status !== 'open') continue;
      if (
        owner.fault &&
        !this.recovering &&
        input.some(
          (event) =>
            event.entity_id !== null && owner.entities.has(event.entity_id),
        )
      )
        throw fail('recording_closed');
      const events = input.filter((event) =>
        event.entity_id === null
          ? event.event.session_id === owner.session.id
          : (!owner.fault || this.recovering) &&
            owner.entities.has(event.entity_id),
      );
      if (!events.length) continue;
      const deadline = performance.now() + this.limits.durability_timeout_ms;
      const remaining = () => Math.max(1, deadline - performance.now());
      try {
        await this.bounded(
          this.resolveCommitted(owner),
          remaining(),
          'recording_event_prepare_timeout',
        );
        const receipts = await this.world.context.db.read(
          this.operation(),
          (tx) =>
            tx.execute<{ n: number }>(
              sql`select count(*)::int as n from lab.recording_event_commits where recording_id=${owner.row.id}::uuid`,
            ),
        );
        const pendingBytes = [...owner.pending.values()].reduce(
          (sum, b) => sum + Buffer.byteLength(JSON.stringify(b.events)),
          0,
        );
        if (
          receipts.rows[0].n >= 255 ||
          pendingBytes + Buffer.byteLength(JSON.stringify(events)) >
            8 * 1024 * 1024
        )
          await this.io(
            owner,
            () => owner.journal.sealAll(),
            'recording_event_prepare_timeout',
            remaining(),
          );
        const batch: PreparedEventBatch = {
          recording_id: owner.row.id,
          batch_id: randomUUID(),
          first_event_sequence: String(owner.eventSequence + 1n),
          event_count: events.length,
          sha256: journalDigest(Buffer.from(JSON.stringify(events))),
          events,
        };
        if (
          events.length > 256 ||
          Buffer.byteLength(JSON.stringify(events)) > 64 * 1024
        )
          throw fail('recording_event_capacity');
        owner.pending.set(batch.batch_id, batch);
        await this.io(
          owner,
          () =>
            owner.journal.append('business.prepare', { ...batch }, this.now()),
          'recording_event_prepare_timeout',
          remaining(),
        );
        if (
          owner.fault &&
          !this.recovering &&
          events.some((event) => event.entity_id !== null)
        )
          throw fail('recording_closed');
        await waitRecordingFault(
          this.faults.prepared?.(owner.row.id, batch.batch_id),
          remaining(),
        );
        result.push(batch);
      } catch (error) {
        this.faultSession(owner.session.id, 'recording_event_prepare_failed');
        throw error;
      }
    }
    return result;
  }
  async witness(tx: DbSession, batches: PreparedEventBatch[]) {
    for (const b of batches) {
      const owner = this.owners.get(b.recording_id)!;
      if (
        owner.fault &&
        !this.recovering &&
        b.events.some((event) => event.entity_id !== null)
      )
        throw fail('recording_closed');
      const last = BigInt(b.first_event_sequence) + BigInt(b.event_count) - 1n;
      const changed = await tx.execute(
        sql`update lab.recordings set event_sequence=${String(last)}::numeric where id=${b.recording_id}::uuid and status='open' and event_sequence=${String(BigInt(b.first_event_sequence) - 1n)}::numeric returning id`,
      );
      if (!changed.rows.length) throw fail('recording_event_conflict');
      await tx.execute(
        sql`insert into lab.recording_event_commits(recording_id,batch_id,first_event_sequence,event_count,sha256,committed_at) values(${b.recording_id}::uuid,${b.batch_id}::uuid,${b.first_event_sequence}::numeric,${b.event_count},${b.sha256},${this.now()}::timestamptz)`,
      );
      owner.row.event_sequence = String(last);
    }
  }
  private async mark(
    owner: Owner,
    batch: PreparedEventBatch,
    recovered = false,
    deadline = performance.now() + this.limits.durability_timeout_ms,
  ) {
    if (batch.marked) return;
    if (!batch.marking)
      batch.marking = this.actualIO(owner, () =>
        owner.journal.append(
          'business.commit',
          {
            batch_id: batch.batch_id,
            sha256: batch.sha256,
            first_event_sequence: batch.first_event_sequence,
            event_count: batch.event_count,
            events: batch.events,
            recovered,
          },
          this.now(),
        ),
      )
        .then(() => {
          batch.marked = true;
        })
        .finally(() => {
          batch.marking = undefined;
        });
    await this.waitIO(
      owner,
      batch.marking,
      'recording_event_commit_timeout',
      Math.max(1, deadline - performance.now()),
    );
  }
  async commit(batches: PreparedEventBatch[]) {
    for (const batch of batches) {
      const owner = this.owners.get(batch.recording_id)!;
      const deadline = performance.now() + this.limits.durability_timeout_ms;
      try {
        await waitRecordingFault(
          this.faults.committed?.(batch.recording_id, batch.batch_id),
          Math.max(1, deadline - performance.now()),
        );
        await this.mark(owner, batch, false, deadline);
        owner.eventSequence =
          BigInt(batch.first_event_sequence) + BigInt(batch.event_count) - 1n;
      } finally {
        batch.finalizerFinished = true;
      }
    }
  }
  async abort(batches: PreparedEventBatch[]) {
    for (const b of batches) {
      const owner = this.owners.get(b.recording_id)!;
      try {
        await this.io(
          owner,
          () =>
            owner.journal.append(
              'business.abort',
              { batch_id: b.batch_id },
              this.now(),
            ),
          'recording_event_abort_timeout',
        );
        owner.pending.delete(b.batch_id);
      } catch (error) {
        this.faultSession(owner.session.id, 'recording_abort_failed');
        throw error;
      }
    }
  }
  private async resolveCommitted(owner: Owner) {
    if (owner.resolving) return owner.resolving;
    const work = this.resource.runInAsyncScope(() =>
      this.resolveCommittedBase(owner),
    );
    owner.resolving = work;
    try {
      await work;
    } finally {
      if (owner.resolving === work) owner.resolving = undefined;
    }
  }
  private async resolveCommittedBase(owner: Owner) {
    await owner.journal.barrier();
    if (!owner.pending.size) return;
    const rows = await this.world.context.db.read(this.operation(), (tx) =>
      tx.execute<{
        batch_id: string;
        sha256: string;
        first_event_sequence: string;
        event_count: number;
      }>(
        sql`select batch_id::text,sha256,first_event_sequence::text,event_count from lab.recording_event_commits where recording_id=${owner.row.id}::uuid`,
      ),
    );
    for (const row of rows.rows) {
      const batch = owner.pending.get(row.batch_id);
      if (!batch) throw fail('recording_committed_payload_missing');
      if (
        batch.sha256 !== row.sha256 ||
        journalDigest(Buffer.from(JSON.stringify(batch.events))) !==
          row.sha256 ||
        batch.first_event_sequence !== row.first_event_sequence ||
        batch.event_count !== Number(row.event_count)
      )
        throw fail('recording_witness_changed');
      await this.mark(owner, batch, true);
      const last =
        BigInt(batch.first_event_sequence) + BigInt(batch.event_count) - 1n;
      if (last > owner.eventSequence) owner.eventSequence = last;
    }
  }
  failed(reason: string, recordingIds?: string[]) {
    for (const owner of this.owners.values())
      if (
        owner.row.status === 'open' &&
        (!recordingIds || recordingIds.includes(owner.row.id))
      )
        this.faultSession(owner.session.id, reason);
  }
  async finish(session: Session, reason: string, complete: boolean) {
    const owner = this.owner(session.id);
    if (
      !owner ||
      owner.row.status === 'deleted' ||
      ((owner.row.status === 'complete' || owner.row.status === 'incomplete') &&
        owner.row.ended_at &&
        owner.row.checkpoint.seal)
    )
      return;
    await this.gate([session.lab_id], async () => {
      if (owner.row.checkpoint.seal && owner.row.ended_at) return;
      const deadline = performance.now() + this.limits.durability_timeout_ms;
      const drain = <T>(work: Promise<T>) =>
        this.bounded(
          work,
          Math.max(1, deadline - performance.now()),
          'recording_drain_timeout',
        );
      try {
        if (owner.inflight) await drain(owner.inflight.settled.catch(() => {}));
        await drain(this.resolveCommitted(owner));
        await drain(owner.journal.barrier());
      } catch (error) {
        this.faultSession(session.id, 'recording_drain_timeout');
        throw error;
      }
      const integral =
        complete &&
        owner.prefix.source_ended &&
        !owner.fault &&
        !owner.journal.corruptReason;
      const parts = await owner.journal.inventory();
      const seal = {
        recording_id: owner.row.id,
        session_id: session.id,
        reason,
        integrity: integral ? 'complete' : 'incomplete',
        final_record_ordinal: parts.at(-1)?.last_ordinal ?? '0',
        ...owner.prefix,
        manifest_sha256: owner.row.manifest_sha256,
        segment_count: parts.length,
        segments_sha256: journalDigest(
          Buffer.from(
            JSON.stringify(
              parts.map((p) => ({
                id: p.id,
                index: p.index,
                sha256: p.sha256,
              })),
            ),
          ),
        ),
      };
      const final = await this.io(
        owner,
        () =>
          owner.journal.append(
            'seal',
            { reason, integrity: seal.integrity, prefix: owner.prefix },
            this.now(),
          ),
        'recording_seal_timeout',
      );
      await this.io(
        owner,
        () => owner.journal.sealAll(),
        'recording_seal_timeout',
      );
      const sealed = (
        await this.world.context.db.read(this.operation(), (tx) =>
          tx.execute<{ id: string; index: number; sha256: string }>(
            sql`select id::text,index,sha256 from lab.recording_segments where recording_id=${owner.row.id}::uuid order by index`,
          ),
        )
      ).rows;
      seal.final_record_ordinal = final.ordinal;
      seal.segment_count = sealed.length;
      seal.segments_sha256 = journalDigest(
        Buffer.from(
          JSON.stringify(
            sealed.map((p) => ({ id: p.id, index: p.index, sha256: p.sha256 })),
          ),
        ),
      );
      await this.world.context.db.transaction(this.operation(), async (tx) => {
        await tx.execute(
          sql`update lab.recordings set status=${integral ? 'complete' : 'incomplete'},reason=${owner.fault ?? reason},ended_at=${this.now()}::timestamptz,checkpoint=${JSON.stringify({ prefix: owner.prefix, seal })}::jsonb,charged_bytes=${owner.row.charged_bytes} where id=${owner.row.id}::uuid`,
        );
        await tx.execute(
          sql`delete from lab.session_assets where session_id=${session.id}::uuid`,
        );
      });
      owner.row.status = integral ? 'complete' : 'incomplete';
      owner.row.reason = owner.fault ?? reason;
      owner.row.ended_at = this.now();
      owner.row.checkpoint = { prefix: owner.prefix, seal };
      await owner.journal.close();
      for (const [ticket, entry] of this.tickets)
        if (entry.scope.session.id === session.id) this.tickets.delete(ticket);
    }).catch(async (error) => {
      this.faultSession(session.id, 'recording_seal_failed');
      owner.row.status = 'incomplete';
      owner.row.reason = owner.fault ?? 'recording_seal_failed';
      owner.row.ended_at = this.now();
      owner.row.checkpoint = { ...owner.row.checkpoint, prefix: owner.prefix };
      await this.world.context.db.transaction(this.operation(), (tx) =>
        tx.execute(
          sql`update lab.recordings set status='incomplete',reason=${owner.row.reason},ended_at=${owner.row.ended_at}::timestamptz,checkpoint=${JSON.stringify(owner.row.checkpoint)}::jsonb,charged_bytes=${owner.row.charged_bytes} where id=${owner.row.id}::uuid`,
        ),
      );
      throw error;
    });
  }
  async initialize() {
    this.recovering = true;
    const rows = await this.world.context.db.read(
      this.operation('startup'),
      (tx) =>
        tx.execute<RecordingRow>(
          sql`select ${recordingColumns} from lab.recordings where status<>'deleted' order by started_at,id`,
        ),
    );
    this.charged = rows.rows.reduce(
      (sum, row) => sum + Number(row.charged_bytes),
      0,
    );
    const stages = await this.world.context.db.read(
      this.operation('startup'),
      (tx) =>
        tx.execute<{ id: string; charged_bytes: number }>(
          sql`select id::text,charged_bytes::float8 from lab.recording_stages order by created_at,id limit 9`,
        ),
    );
    if (stages.rows.length > 8) throw fail('recording_stage_capacity');
    this.charged += stages.rows.reduce(
      (sum, s) => sum + Number(s.charged_bytes),
      0,
    );
    for (const stage of stages.rows) await this.abortStage(stage.id);
    for (const row of rows.rows) {
      if (row.status === 'deleting') {
        await this.deleteOwned(row);
        continue;
      }
      const sessionRows = await this.world.context.db.read(
        this.operation('startup'),
        (tx) =>
          tx.execute<{ value: Session }>(
            sql`select to_jsonb(s)||jsonb_build_object('epoch',s.epoch::text) as value from lab.simulation_sessions s where id=${row.session_id}::uuid`,
          ),
      );
      const session = sessionRows.rows[0].value;
      const owner = this.createOwner(row, session);
      const last = await this.world.context.db.read(
        this.operation('startup'),
        (tx) =>
          tx.execute<{ index: number; last_ordinal: string }>(
            sql`select index,last_ordinal::text from lab.recording_segments where recording_id=${row.id}::uuid order by index`,
          ),
      );
      await owner.journal.initialize(last.rows);
      const witnessRows = await this.world.context.db.read(
        this.operation('startup'),
        (tx) =>
          tx.execute<{ batch_id: string }>(
            sql`select batch_id::text from lab.recording_event_commits where recording_id=${row.id}::uuid limit 257`,
          ),
      );
      if (witnessRows.rows.length > 256)
        throw fail('recording_recovery_capacity');
      const witnessIds = new Set(witnessRows.rows.map((r) => r.batch_id));
      const pending = new Map<string, PreparedEventBatch>();
      for await (const record of this.records(row.id)) {
        if (record.kind === 'source.header') {
          owner.identity = record.data.identity as unknown as RecordingIdentity;
          owner.headerDigest = String(record.data.source_header_sha256);
          owner.prefix.source_prefix_sha256 = String(
            record.data.source_prefix_sha256,
          );
        } else if (record.kind === 'source.packet') {
          const packet = await decodeRecordingPacket(
            Buffer.from(String(record.data.packet_base64), 'base64'),
            owner.identity,
          );
          if (
            packet.source_packet_sequence !==
            BigInt(owner.prefix.source_packet_sequence) + 1n
          )
            throw fail('recording_recovery_gap');
          const prefix = await advanceSourcePrefix(
            owner.prefix.source_prefix_sha256!,
            packet.packet_sha256,
          );
          if (prefix !== record.data.source_prefix_sha256)
            throw fail('recording_recovery_digest');
          owner.prefix.source_packet_sequence = String(
            packet.source_packet_sequence,
          );
          owner.prefix.source_prefix_sha256 = prefix;
          if (packet.kind === 1) {
            const i = session.snapshot.installation,
              batch = decodeFrameBatch(packet.payload, {
                epoch: packet.epoch,
                mapping_revision: i.mapping_revision,
                body_count: i.pose_keys.length,
                joint_count: i.joint_keys.length,
              });
            for (const f of batch.frames) {
              const b = {
                sequence: String(f.snapshot.sequence),
                time: String(f.snapshot.sim_time_ns),
                sha256: journalDigest(f.bytes),
              };
              owner.initial ??= b;
              owner.lastFrame = b;
            }
            owner.prefix.last_source_sequence = owner.lastFrame!.sequence;
            owner.prefix.last_sim_time_ns = owner.lastFrame!.time;
          } else if (packet.kind === 2) {
            owner.transition = parseSourceEvent(
              new TextDecoder().decode(packet.payload),
            );
            owner.prefix.last_source_event_sequence =
              owner.transition.source_event_sequence;
          } else owner.prefix.source_ended = true;
        } else if (record.kind === 'business.prepare') {
          const batch = record.data as unknown as PreparedEventBatch;
          pending.set(batch.batch_id, batch);
          if (witnessIds.has(batch.batch_id))
            owner.pending.set(batch.batch_id, batch);
          if (pending.size > 256) throw fail('recording_recovery_capacity');
        } else if (record.kind === 'business.commit') {
          const batch = owner.pending.get(String(record.data.batch_id));
          if (batch) batch.marked = true;
          pending.delete(String(record.data.batch_id));
        } else if (record.kind === 'business.abort') {
          pending.delete(String(record.data.batch_id));
          owner.pending.delete(String(record.data.batch_id));
        }
      }
      for (const batch of pending.values()) {
        const receipts = await this.world.context.db.read(
          this.operation('startup'),
          (tx) =>
            tx.execute<{ sha256: string }>(
              sql`select sha256 from lab.recording_event_commits where recording_id=${row.id}::uuid and batch_id=${batch.batch_id}::uuid`,
            ),
        );
        if (
          receipts.rows[0]?.sha256 === batch.sha256 &&
          journalDigest(Buffer.from(JSON.stringify(batch.events))) ===
            batch.sha256
        ) {
          await owner.journal.append(
            'business.commit',
            {
              batch_id: batch.batch_id,
              sha256: batch.sha256,
              first_event_sequence: batch.first_event_sequence,
              event_count: batch.event_count,
              events: batch.events,
            },
            this.now(),
          );
          batch.marked = true;
          owner.pending.set(batch.batch_id, batch);
        } else if (receipts.rows.length)
          owner.fault = 'recording_event_bytes_missing';
        else
          await owner.journal.append(
            'business.abort',
            { batch_id: batch.batch_id },
            this.now(),
          );
      }
      if (owner.journal.corruptReason)
        owner.fault = owner.journal.corruptReason;
      if (
        (row.status === 'complete' || row.status === 'incomplete') &&
        row.checkpoint.seal
      ) {
        await owner.journal.close();
      } else if (session.ended_at || row.ended_at) {
        await this.finish(
          session,
          'server_recovered',
          row.status !== 'incomplete' &&
            owner.prefix.source_ended &&
            session.status === 'stopped',
        );
      }
    }
  }
  async recoverLegacy() {
    const rows = await this.world.context.db.read(
      this.operation('startup'),
      (tx) =>
        tx.execute<{ value: Session; actor: string }>(
          sql`select to_jsonb(s)||jsonb_build_object('epoch',s.epoch::text) as value,s.started_by::text as actor from lab.simulation_sessions s where not exists(select 1 from lab.recordings r where r.session_id=s.id) order by s.started_at,s.id limit 65`,
        ),
    );
    try {
      for (const entry of rows.rows) {
        try {
          await this.preparation(entry.value.lab_id, async () => {
            await this.prepareSession(entry.value, entry.actor);
            this.faultSession(
              entry.value.id,
              'reliable_capture_unavailable_at_start',
            );
            await this.finish(
              entry.value,
              'reliable_capture_unavailable_at_start',
              false,
            );
          });
        } catch (error) {
          if (!(error instanceof PublicFailure) || error.status !== 429)
            throw error;
          // Remaining legacy Sessions keep their original pins. Serving existing
          // data is safe; admitting another Recording would not be.
          this.admissionUnavailable =
            'Legacy Recording adoption capacity reached';
          break;
        }
      }
    } finally {
      this.recovering = false;
    }
  }
  private async authorized(
    headers: Headers,
    id: string,
    lab: string,
    write = false,
  ) {
    return this.world.context.db.transaction(
      this.operation('request'),
      async (tx) => {
        await accessIn(
          tx,
          this.world.context,
          this.world.policy,
          headers,
          'lab:full',
          write,
        );
        return this.rowIn(tx, lab, id);
      },
    );
  }
  async list(headers: Headers, lab: string, cursor?: string, limit = 20) {
    return this.world.context.db.transaction(
      this.operation('request'),
      async (tx) => {
        await accessIn(
          tx,
          this.world.context,
          this.world.policy,
          headers,
          'lab:full',
        );
        await loadLab(tx, lab);
        if (cursor) worldId(cursor);
        const rows = await tx.execute<RecordingRow>(
          sql`select ${recordingColumns} from lab.recordings where lab_id=${lab}::uuid and status<>'deleted' and ${cursor ? sql`id>${cursor}::uuid` : sql`true`} order by id limit ${limit + 1}`,
        );
        return {
          data: rows.rows.slice(0, limit).map((r) => this.metadata(r)),
          next_cursor:
            rows.rows.length > limit ? rows.rows[limit - 1].id : null,
        };
      },
    );
  }
  async get(headers: Headers, lab: string, id: string) {
    const row = await this.authorized(headers, id, lab);
    await this.readBarrier(id);
    return this.metadata(row);
  }
  async manifest(headers: Headers, lab: string, id: string) {
    const row = await this.authorized(headers, id, lab);
    if (!row.manifest_file_id) throw fail('recording_not_ready');
    const parts: Uint8Array[] = [];
    for await (const part of await this.files.managedBytes(
      row.manifest_file_id,
      this.operation('request'),
    ))
      parts.push(part);
    return JSON.parse(Buffer.concat(parts).toString('utf8'));
  }
  async segments(
    headers: Headers,
    lab: string,
    id: string,
    cursor?: string,
    limit = 20,
  ) {
    await this.authorized(headers, id, lab);
    const deadline = performance.now() + this.limits.durability_timeout_ms;
    return this.bounded(
      this.segmentsBase(id, cursor, limit, deadline),
      this.limits.durability_timeout_ms,
      'recording_read_timeout',
    );
  }
  private async segmentsBase(
    id: string,
    cursor: string | undefined,
    limit: number,
    deadline: number,
  ) {
    await this.readBarrier(id);
    const rows = await this.world.context.db.read(
      this.operation('request'),
      (tx) =>
        tx.execute<{
          id: string;
          index: number;
          file_id: string;
          size: number;
          sha256: string;
          first_ordinal: string;
          last_ordinal: string;
        }>(
          sql`select id::text,index,file_id::text,size,sha256,first_ordinal::text,last_ordinal::text from lab.recording_segments where recording_id=${id}::uuid order by index limit 1024`,
        ),
    );
    const data = rows.rows.map((r) => ({ ...r, sealed: true }));
    const owner = this.owners.get(id);
    if (owner) {
      for (const p of owner.journal.snapshot())
        if (!data.some((r) => r.id === p.id))
          data.push({
            id: p.id,
            index: p.index,
            file_id: null as unknown as string,
            size: p.size,
            sha256:
              p.sha256 ||
              journalDigest((await readFile(p.path)).subarray(0, p.size)),
            first_ordinal: p.first_ordinal,
            last_ordinal: p.last_ordinal,
            sealed: false,
          });
    }
    if (performance.now() >= deadline) throw fail('recording_read_timeout');
    const after = cursor ? this.cursor(cursor, id) : { index: -1 };
    if (!Number.isInteger(after.index) || Number(after.index) < -1)
      throw fail('recording_invalid_cursor', 'Invalid segment cursor', 400);
    const page = data
      .filter((p) => p.index > Number(after.index))
      .sort((a, b) => a.index - b.index);
    return {
      data: page.slice(0, limit),
      next_cursor:
        page.length > limit
          ? Buffer.from(
              JSON.stringify({
                recording_id: id,
                index: page[limit - 1].index,
              }),
            ).toString('base64url')
          : null,
    };
  }
  async segment(headers: Headers, lab: string, id: string, segmentId: string) {
    await this.authorized(headers, id, lab);
    return this.bounded(
      this.segmentBase(id, segmentId),
      this.limits.durability_timeout_ms,
      'recording_read_timeout',
    );
  }
  private async segmentBase(id: string, segmentId: string) {
    const result = await this.world.context.db.read(
      this.operation('request'),
      (tx) =>
        tx.execute<{ file_id: string; size: number }>(
          sql`select file_id::text,size from lab.recording_segments where recording_id=${id}::uuid and id=${worldId(segmentId)}::uuid`,
        ),
    );
    if (result.rows[0]) {
      return {
        bytes: await this.files.managedBytes(
          result.rows[0].file_id,
          this.operation('request'),
        ),
        size: result.rows[0].size,
      };
    }
    await this.readBarrier(id);
    const p = this.owners
      .get(id)
      ?.journal.snapshot()
      .find((p) => p.id === segmentId);
    if (!p) throw fail('recording_segment_not_found', 'Segment not found', 404);
    const bytes = (await readFile(p.path)).subarray(0, p.size);
    return {
      bytes: (async function* () {
        yield bytes;
      })(),
      size: bytes.length,
    };
  }
  private async *records(id: string): AsyncGenerator<JournalRecord> {
    const archived = await this.world.context.db.read(this.operation(), (tx) =>
      tx.execute<{ id: string; index: number; file_id: string }>(
        sql`select id::text,index,file_id::text from lab.recording_segments where recording_id=${id}::uuid order by index limit 1024`,
      ),
    );
    const local = this.owners.get(id)?.journal.snapshot() ?? [];
    const parts = [
      ...archived.rows.map((p) => ({
        ...p,
        path: null as string | null,
        size: 0,
      })),
      ...local
        .filter((p) => !archived.rows.some((a) => a.id === p.id))
        .map((p) => ({ ...p, file_id: null as string | null })),
    ].sort((a, b) => a.index - b.index);
    for (const part of parts) {
      if (part.file_id) {
        const chunks: Uint8Array[] = [];
        for await (const chunk of await this.files.managedBytes(
          part.file_id,
          this.operation(),
        ))
          chunks.push(chunk);
        for (const record of decodeJournalBytes(Buffer.concat(chunks)))
          yield record;
      } else if (part.path) yield* readJournal(part.path, part.size);
    }
  }
  async events(
    headers: Headers,
    lab: string,
    id: string,
    cursor?: string,
    limit = 20,
  ) {
    const row = await this.authorized(headers, id, lab);
    const deadline = performance.now() + this.limits.durability_timeout_ms;
    return this.bounded(
      this.eventsBase(row, id, cursor, limit, deadline),
      this.limits.durability_timeout_ms,
      'recording_read_timeout',
    );
  }
  private async eventsBase(
    row: RecordingRow,
    id: string,
    cursor: string | undefined,
    limit: number,
    deadline: number,
  ) {
    await this.readBarrier(id);
    const after = cursor
      ? this.cursor(cursor, id)
      : { recording_id: id, ordinal: '0', index: -1 };
    if (
      after.recording_id !== id ||
      !/^\d+$/.test(after.ordinal) ||
      !Number.isInteger(after.index)
    )
      throw fail('recording_invalid_cursor', 'Invalid Recording cursor', 400);
    const data: Array<Record<string, unknown>> = [];
    const prepared = new Map<string, PreparedEventBatch>();
    let bytes = 0,
      last = after;
    for await (const record of this.records(id)) {
      if (performance.now() >= deadline) throw fail('recording_read_timeout');
      let events: Array<Record<string, unknown>> = [];
      if (record.kind === 'business.prepare')
        prepared.set(
          String(record.data.batch_id),
          record.data as unknown as PreparedEventBatch,
        );
      else if (record.kind === 'business.commit') {
        const batch = prepared.get(String(record.data.batch_id));
        if (
          Array.isArray(record.data.events) &&
          journalDigest(Buffer.from(JSON.stringify(record.data.events))) ===
            record.data.sha256
        )
          events = record.data.events as Array<Record<string, unknown>>;
        else if (batch && batch.sha256 === record.data.sha256)
          events = batch.events;
        prepared.delete(String(record.data.batch_id));
      } else if (record.kind === 'business.abort')
        prepared.delete(String(record.data.batch_id));
      else if (record.kind === 'business.event') events = [record.data];
      else if (record.kind === 'source.packet') {
        const packet = await decodeRecordingPacket(
          Buffer.from(String(record.data.packet_base64), 'base64'),
        );
        if (packet.kind === 2) {
          const event = parseSourceEvent(
            new TextDecoder().decode(packet.payload),
          );
          events = [
            {
              event_id: event.event_id,
              event_type: event.event_type,
              entity_id: null,
              recorded_at: record.recorded_at,
              sim_time_ns: event.sim_time_ns,
              event: event.event,
            },
          ];
        }
      }
      for (let index = 0; index < events.length; index++) {
        if (
          BigInt(record.ordinal) < BigInt(after.ordinal) ||
          (record.ordinal === after.ordinal && index <= after.index)
        )
          continue;
        const entry = { ordinal: record.ordinal, ...events[index] },
          size = Buffer.byteLength(JSON.stringify(entry));
        if (data.length >= limit || bytes + size > 256 * 1024)
          return {
            data,
            next_cursor: Buffer.from(JSON.stringify(last)).toString(
              'base64url',
            ),
            integrity: this.metadata(row).integrity,
          };
        data.push(entry);
        bytes += size;
        last = { recording_id: id, ordinal: record.ordinal, index };
      }
    }
    return { data, next_cursor: null, integrity: this.metadata(row).integrity };
  }
  async delete(headers: Headers, lab: string, id: string) {
    const row = await this.authorized(headers, id, lab, true);
    if (row.status === 'open' || row.status === 'preparing')
      throw fail(
        'recording_in_use',
        'Stop the Session before deleting its Recording',
      );
    await this.world.context.db.transaction(this.operation('request'), (tx) =>
      tx.execute(
        sql`update lab.recordings set status='deleting' where id=${id}::uuid`,
      ),
    );
    await this.deleteOwned(row);
  }
  private async deleteOwned(row: RecordingRow) {
    await this.gate([row.lab_id], async () => {
      const owner = this.owners.get(row.id);
      if (owner) await owner.journal.remove();
      else {
        const journal = new RecordingJournal(
          this.directory,
          row.id,
          row.session_id,
          async () => {},
        );
        const published = await this.world.context.db.read(
          this.operation(),
          (tx) =>
            tx.execute<{ index: number; last_ordinal: string }>(
              sql`select index,last_ordinal::text from lab.recording_segments where recording_id=${row.id}::uuid order by index`,
            ),
        );
        await journal.initialize(published.rows);
        await journal.remove();
      }
      await this.world.context.db.transaction(this.operation(), async (tx) => {
        const resources = await tx.execute<{ file_id: string }>(
          sql`select file_id::text from lab.recording_resources where recording_id=${row.id}::uuid`,
        );
        await tx.execute(
          sql`delete from lab.recording_segments where recording_id=${row.id}::uuid`,
        );
        await tx.execute(
          sql`delete from lab.recording_resources where recording_id=${row.id}::uuid`,
        );
        await tx.execute(
          sql`delete from lab.recording_event_commits where recording_id=${row.id}::uuid`,
        );
        await tx.execute(
          sql`update lab.recordings set status='deleted',manifest_file_id=null,charged_bytes=0 where id=${row.id}::uuid`,
        );
        for (const resource of resources.rows)
          await this.files.release(tx, resource.file_id, {
            ownerType: 'lab.recording',
            ownerId: row.id,
          });
      });
      this.charged -= Number(owner?.row.charged_bytes ?? row.charged_bytes);
      this.owners.delete(row.id);
      this.bySession.delete(row.session_id);
    });
  }
  async sealForBackup() {
    for (const owner of this.owners.values()) {
      if (owner.row.status === 'open' || owner.row.status === 'preparing')
        await this.finish(
          {
            ...owner.session,
            status: 'interrupted',
            ended_at: this.now(),
            reason: 'offline_archive_recovery',
          },
          'offline_archive_recovery',
          false,
        );
      else {
        const registered = await this.world.context.db.read(
          this.operation('startup'),
          (tx) =>
            tx.execute<{ index: number; sha256: string }>(
              sql`select index,sha256 from lab.recording_segments where recording_id=${owner.row.id}::uuid`,
            ),
        );
        for (const part of await owner.journal.inventory())
          if (
            !registered.rows.some(
              (r) => r.index === part.index && r.sha256 === part.sha256,
            )
          )
            throw fail('recording_archive_unsealed');
      }
    }
  }
  async stop() {
    this.stopping = true;
    this.tickets.clear();
    const errors: unknown[] = [];
    for (const owner of this.owners.values())
      if (owner.row.status === 'open' || owner.row.status === 'preparing') {
        this.faultSession(owner.session.id, 'server_shutdown');
        try {
          await this.finish(
            {
              ...owner.session,
              status: 'interrupted',
              ended_at: this.now(),
              reason: 'server_shutdown',
            },
            'server_shutdown',
            false,
          );
        } catch (error) {
          errors.push(error);
        }
      }
    // A timed-out caller is not a cancelled write. Kernel I/O retains custody
    // until it settles; runtime cannot release its DB/directory lease before us.
    await Promise.allSettled(
      [...this.owners.values()].flatMap((owner) => [
        owner.inflight?.settled,
        owner.resolving,
        ...owner.io,
        owner.cleanup,
      ]),
    );
    for (const owner of this.owners.values())
      try {
        await owner.journal.close();
      } catch (error) {
        errors.push(error);
      }
    if (errors.length)
      throw new AggregateError(errors, 'Recording shutdown incomplete');
  }
}
