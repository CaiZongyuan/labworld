import {
  getLabAssetDownload,
  type ApiClient,
  type LabAsset,
} from '@labos-threejs/sdk';
import { ModelImportError } from './glb';
import {
  acquisitionFact,
  acquisitionIdentity,
  acquisitionResource,
} from './model-acquisition-facts';

export type ModelByteSource = {
  asset: LabAsset;
  apiClient: ApiClient;
  authority: object;
};
export type ModelByteLease = {
  bytes: Promise<ArrayBuffer>;
  release: () => void;
};
const owners = new WeakMap<
  object,
  WeakMap<object, WeakMap<ApiClient, Map<string, Attempt>>>
>();
const aborted = () =>
  new DOMException('Model byte consumer ended', 'AbortError');

export function modelResourceKey(asset: LabAsset) {
  const r = asset.representation;
  return JSON.stringify([asset.id, r.id, r.file_id, r.sha256, r.size]);
}

class Attempt {
  readonly diagnosticId = acquisitionIdentity(this);
  readonly controller = new AbortController();
  readonly bytes: Promise<ArrayBuffer>;
  consumers = 0;
  settled = false;
  constructor(
    source: ModelByteSource,
    readonly retire: (attempt: Attempt) => void,
  ) {
    this.bytes = this.read(source).then(
      (bytes) => {
        acquisitionFact('attempt-settled', {
          attempt: this.diagnosticId,
          success: true,
        });
        this.settled = true;
        this.retire(this);
        return bytes;
      },
      (error) => {
        acquisitionFact('attempt-settled', {
          attempt: this.diagnosticId,
          success: false,
        });
        this.settled = true;
        this.retire(this);
        throw error;
      },
    );
  }
  private async read(source: ModelByteSource) {
    const counters = {
      attempt: this.diagnosticId,
      authority: acquisitionIdentity(source.authority),
      client: acquisitionIdentity(source.apiClient),
      resource: acquisitionResource(modelResourceKey(source.asset)),
    };
    acquisitionFact('capability-start', counters);
    const r = source.asset.representation;
    const { data } = await getLabAssetDownload({
      client: source.apiClient,
      path: { id: source.asset.id },
      signal: this.controller.signal,
      throwOnError: true,
    });
    const metadataMatch =
      data.file.id === r.file_id &&
      data.file.sha256 === r.sha256 &&
      data.file.size === r.size;
    acquisitionFact('capability-ready', { ...counters, metadataMatch });
    if (!metadataMatch) throw new ModelImportError('invalid');
    acquisitionFact('bytes-start', counters);
    const response = await fetch(data.url, {
      headers: data.headers,
      signal: this.controller.signal,
    });
    acquisitionFact('bytes-response', { ...counters, status: response.status });
    if (!response.ok) throw new ModelImportError('failed');
    const bytes = await response.arrayBuffer();
    if (bytes.byteLength !== r.size) throw new ModelImportError('invalid');
    return bytes;
  }
}

/** Share only pending authorized bytes, owned by this Canvas and authority. */
export function acquireModelBytes(
  owner: object,
  source: ModelByteSource,
  signal: AbortSignal,
): ModelByteLease {
  if (signal.aborted)
    return {
      bytes: Promise.reject(signal.reason ?? aborted()),
      release: () => {},
    };
  let scopes = owners.get(owner);
  if (!scopes) owners.set(owner, (scopes = new WeakMap()));
  let clients = scopes.get(source.authority);
  if (!clients) scopes.set(source.authority, (clients = new WeakMap()));
  let resources = clients.get(source.apiClient);
  if (!resources) clients.set(source.apiClient, (resources = new Map()));
  const key = modelResourceKey(source.asset);
  const current = resources;
  let attempt = current.get(key);
  if (!attempt) {
    attempt = new Attempt(source, (finished) => {
      if (current.get(key) === finished) current.delete(key);
    });
    current.set(key, attempt);
  }
  const shared = attempt;
  shared.consumers++;
  const counters = {
    owner: acquisitionIdentity(owner),
    authority: acquisitionIdentity(source.authority),
    client: acquisitionIdentity(source.apiClient),
    resource: acquisitionResource(key),
    attempt: shared.diagnosticId,
  };
  acquisitionFact('lease-acquired', {
    ...counters,
    consumers: shared.consumers,
  });
  let active = true;
  let rejectWait: (reason: unknown) => void = () => {};
  const release = () => {
    if (!active) return;
    active = false;
    signal.removeEventListener('abort', release);
    shared.consumers--;
    acquisitionFact('lease-released', {
      ...counters,
      consumers: shared.consumers,
      aborted: signal.aborted,
    });
    rejectWait(signal.reason ?? aborted());
    if (shared.consumers === 0 && !shared.settled) {
      shared.retire(shared);
      shared.controller.abort();
    }
  };
  const bytes = new Promise<ArrayBuffer>((resolve, reject) => {
    rejectWait = reject;
    shared.bytes.then(
      (value) => {
        if (active) resolve(value);
      },
      (error) => {
        if (active) reject(error);
      },
    );
  });
  signal.addEventListener('abort', release, { once: true });
  return { bytes, release };
}
