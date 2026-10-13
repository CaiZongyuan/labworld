import {
  getLabAssetDownload,
  type ApiClient,
  type LabAsset,
} from '@labos-threejs/sdk';
import { ModelImportError } from './glb';

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
        this.settled = true;
        this.retire(this);
        return bytes;
      },
      (error) => {
        this.settled = true;
        this.retire(this);
        throw error;
      },
    );
  }
  private async read(source: ModelByteSource) {
    const r = source.asset.representation;
    const { data } = await getLabAssetDownload({
      client: source.apiClient,
      path: { id: source.asset.id },
      signal: this.controller.signal,
      throwOnError: true,
    });
    if (
      data.file.id !== r.file_id ||
      data.file.sha256 !== r.sha256 ||
      data.file.size !== r.size
    )
      throw new ModelImportError('invalid');
    const response = await fetch(data.url, {
      headers: data.headers,
      signal: this.controller.signal,
    });
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
  let active = true;
  let rejectWait: (reason: unknown) => void = () => {};
  const release = () => {
    if (!active) return;
    active = false;
    signal.removeEventListener('abort', release);
    shared.consumers--;
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
