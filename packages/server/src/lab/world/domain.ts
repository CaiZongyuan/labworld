export type PersistentLab = {
  id: string;
  name: string;
  layout_version: number;
  created_by: string;
  created_at: string;
};
export type DefinitionCapability = {
  id: string;
  version: string;
  parameters: unknown;
  result: unknown;
  implemented: boolean;
};
export type AssetDefinition = {
  id: string;
  version: string;
  name: string;
  name_en: string;
  category: string;
  specifications: unknown;
  capabilities: DefinitionCapability[];
  state: unknown;
  interfaces: { id: string; implemented: boolean }[];
};
export type RuntimeBinding = {
  id: string;
  entity_id: string;
  program_id: string;
  source: string;
  definition_id: string;
  definition_version: string;
  definition: AssetDefinition;
};
export type EntityCapability = {
  id: string;
  version: string;
  definition_supported: boolean;
  binding_implemented: boolean;
  executable: boolean;
  reason: string;
  parameters: unknown;
  result: unknown;
};
export type LabEntity = {
  id: string;
  lab_id: string;
  name: string;
  kind: string;
  reality: string;
  definition_id: string;
  definition_version: string;
  definition: AssetDefinition;
  configuration: Record<string, unknown>;
  representation_id: string | null;
  created_by: string;
  updated_by: string;
  created_at: string;
  updated_at: string;
  archived_at: string | null;
  binding: RuntimeBinding | null;
  program_run: Record<string, unknown> | null;
  observation: Record<string, unknown> | null;
  task: Record<string, unknown> | null;
  task_result: Record<string, unknown> | null;
  capabilities: EntityCapability[];
};
export type Placement = {
  position: [number, number, number];
  rotation: [number, number, number];
  scale: [number, number, number];
};
export type SceneNode = {
  id: string;
  lab_id: string;
  entity_id: string;
  representation_id: string | null;
  placement: Placement;
};
export type RegisterEntity = {
  name: string;
  definition_id: string;
  definition_version: string;
  reality: 'simulated' | 'physical';
  configuration: Record<string, unknown>;
  representation_id?: string | null;
};
export type CreateSceneNode = {
  entity_id: string;
  representation_id?: string | null;
  placement: Placement;
};
export type CopyLabEntity = {
  expected_version: number;
  name: string;
  placement: Placement;
};
export function validPlacement(value: Placement) {
  return (
    [value.position, value.rotation, value.scale].every(
      (axis) => axis.length === 3,
    ) &&
    [...value.position, ...value.rotation].every(
      (number) => Number.isFinite(number) && Math.abs(number) <= 10000,
    ) &&
    value.scale.every(
      (number) => Number.isFinite(number) && number >= 0.001 && number <= 1000,
    )
  );
}
export function validConfiguration(configuration: Record<string, unknown>) {
  return new TextEncoder().encode(JSON.stringify(configuration)).length <= 8192;
}
export function placementAt(count: number): Placement {
  return {
    position: [(count % 5) * 1.5, 0, Math.floor(count / 5) * 1.5],
    rotation: [0, 0, 0],
    scale: [1, 1, 1],
  };
}
export function validName(value: string) {
  return (
    value.trim().length > 0 &&
    [...value].length <= 120 &&
    !/[\p{Cc}]/u.test(value)
  );
}
