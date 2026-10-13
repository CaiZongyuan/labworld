export type AssetDescription = {
  schema_version: 1;
  asset_id: string;
  version: string;
  name: string;
  name_en?: string;
  category: string;
  manufacturer?: string;
  model?: string;
  description?: string;
  source: string;
  license: string;
  specifications: Record<string, unknown>;
  configuration_schema: Record<string, unknown>;
  state_schema: Record<string, unknown>;
  capabilities: {
    id: string;
    version: string;
    parameters: Record<string, unknown>;
    result: Record<string, unknown>;
    description?: string;
  }[];
  resources: {
    key: string;
    file_id: string;
    format: 'glb' | 'usd' | 'urdf' | 'pdf' | 'json';
    sha256: string;
    size: number;
  }[];
  representations: {
    key: string;
    purpose: 'visual' | 'simulation' | 'documentation';
    resource_keys: string[];
    components: {
      key: string;
      resource_key: string;
      local_origin: { position: number[]; quaternion: number[] };
    }[];
  }[];
};
export type VersionResource = AssetDescription['resources'][number] & {
  file_name: string;
  content_type: string;
  representation_id: string | null;
  verification:
    'glb-validated' | 'json-parsed' | 'pdf-header' | 'usd-header' | 'opaque';
};
export type AssetVersion = {
  id: string;
  asset_id: string;
  namespace: string;
  version: string;
  content_sha256: string;
  definition: Omit<AssetDescription, 'resources' | 'representations'>;
  representations: AssetDescription['representations'];
  resources: VersionResource[];
  created_by: string;
  created_at: string;
};
