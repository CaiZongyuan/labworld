import { z } from '@hono/zod-openapi';
import { LabAsset } from '../assets/routes.ts';
const instant = z.string().openapi({ format: 'date-time' }),
  i64 = z.number().openapi({ type: 'integer', format: 'int64' });
const jsonValue = z.unknown().refine((value) => value !== undefined);
const record = (value: z.ZodType) =>
  z
    .record(z.string(), value)
    .openapi({ ...{ propertyNames: { type: 'string' as const } } });
const nullable = (value: z.ZodType) =>
  z
    .union([value, z.null()])
    .openapi({}, { unionPreferredType: 'oneOf' })
    .optional();
export const DefinitionCapability = z
  .object({
    id: z.string(),
    version: z.string().optional(),
    parameters: jsonValue,
    result: jsonValue.optional(),
    implemented: z.boolean(),
  })
  .openapi('DefinitionCapability');
export const DefinitionInterface = z
  .object({ id: z.string(), implemented: z.boolean() })
  .openapi('DefinitionInterface');
export const AssetDefinition = z
  .object({
    id: z.string(),
    version: z.string(),
    name: z.string(),
    name_en: z.string(),
    category: z.string(),
    specifications: jsonValue,
    capabilities: z.array(DefinitionCapability),
    state: jsonValue,
    interfaces: z.array(DefinitionInterface),
  })
  .openapi('AssetDefinition');
export const RuntimeBinding = z
  .object({
    id: z.string(),
    entity_id: z.string(),
    program_id: z.string(),
    source: z.string(),
    definition_id: z.string(),
    definition_version: z.string(),
    definition: AssetDefinition,
  })
  .openapi('RuntimeBinding');
export const DeviceProgramRun = z
  .object({
    id: z.string(),
    entity_id: z.string(),
    binding_id: z.string(),
    program_id: z.string(),
    source: z.string(),
    definition_id: z.string(),
    definition_version: z.string(),
    definition: AssetDefinition,
    configuration: jsonValue,
    status: z.string(),
    started_by: z.string(),
    started_at: instant,
    ended_at: instant.nullable().optional(),
  })
  .openapi('DeviceProgramRun');
export const ObservationProperty = z
  .object({
    value: jsonValue,
    unit: z.string().nullable().optional(),
    binding_id: z.string(),
    run_id: z.string(),
    sequence: i64,
    source: z.string(),
    observed_at: instant.nullable().optional(),
    received_at: instant,
    updated_at: instant,
    expires_at: instant,
    quality: z.string(),
    freshness: z.string(),
  })
  .openapi('ObservationProperty');
export const DeviceObservation = z
  .object({
    entity_id: z.string(),
    run_id: z.string(),
    sequence: i64,
    source: z.string(),
    values: jsonValue,
    observed_at: instant.nullable().optional(),
    received_at: instant,
    updated_at: instant,
    quality: z.string(),
    freshness: z.string(),
    properties: record(ObservationProperty),
  })
  .openapi('DeviceObservation');
export const DeviceTask = z
  .object({
    id: z.string(),
    entity_id: z.string(),
    run_id: z.string(),
    command_id: z.string(),
    result_id: z.string(),
    parameters: jsonValue,
    status: z.string(),
    elapsed_seconds: z.number().openapi({ format: 'double' }),
    timer_started_at: instant.nullable().optional(),
    created_at: instant,
    ended_at: instant.nullable().optional(),
  })
  .openapi('DeviceTask');
export const DeviceTaskResult = z
  .object({
    id: z.string(),
    task_id: z.string(),
    status: z.string(),
    reason: z.string().nullable().optional(),
    ended_at: instant.nullable().optional(),
  })
  .openapi('DeviceTaskResult');
export const EntityCapability = z
  .object({
    id: z.string(),
    version: z.string(),
    definition_supported: z.boolean(),
    binding_implemented: z.boolean(),
    executable: z.boolean(),
    reason: z.string(),
    parameters: jsonValue,
    result: jsonValue,
  })
  .openapi('EntityCapability');
export const LabEntity = z
  .object({
    id: z.string(),
    lab_id: z.string(),
    name: z.string(),
    kind: z.string(),
    reality: z.string(),
    definition_id: z.string(),
    definition_version: z.string(),
    definition: AssetDefinition,
    configuration: record(z.unknown()),
    representation_id: z.string().nullable().optional(),
    created_by: z.string(),
    updated_by: z.string(),
    created_at: instant,
    updated_at: instant,
    archived_at: instant.nullable().optional(),
    binding: nullable(RuntimeBinding),
    program_run: nullable(DeviceProgramRun),
    observation: nullable(DeviceObservation),
    task: nullable(DeviceTask),
    task_result: nullable(DeviceTaskResult),
    capabilities: z.array(EntityCapability),
  })
  .openapi('LabEntity');
export const PersistentLab = z
  .object({
    id: z.string(),
    name: z.string(),
    layout_version: i64,
    created_by: z.string(),
    created_at: instant,
  })
  .openapi('PersistentLab');
export const LabPage = z
  .object({
    data: z.array(PersistentLab),
    next_cursor: z.string().nullable().optional(),
    has_more: z.boolean(),
  })
  .openapi('LabPage');
export const CreateLab = z
  .object({ name: z.string() })
  .strict()
  .openapi('CreateLab');
export const EntityReality = z
  .enum(['simulated', 'physical'])
  .openapi('EntityReality');
const axis = z.array(z.number().openapi({ format: 'double' })).length(3);
export const Placement = z
  .object({
    position: axis,
    rotation: axis,
    scale: axis,
  })
  .strict()
  .openapi('Placement');
export const SceneNode = z
  .object({
    id: z.string(),
    lab_id: z.string(),
    entity_id: z.string(),
    representation_id: z.string().nullable().optional(),
    placement: Placement,
  })
  .openapi('SceneNode');
export const RegisterEntity = z
  .object({
    name: z.string(),
    definition_id: z.string(),
    definition_version: z.string(),
    reality: EntityReality,
    configuration: record(z.unknown()),
    representation_id: z.string().nullable().optional(),
  })
  .strict()
  .openapi('RegisterEntity');
export const ConfigureEntity = z
  .object({ name: z.string(), configuration: record(z.unknown()) })
  .strict()
  .openapi('ConfigureEntity');
export const CreateSceneNode = z
  .object({
    entity_id: z.string(),
    representation_id: z.string().nullable().optional(),
    placement: Placement,
  })
  .strict()
  .openapi('CreateSceneNode');
export const CopyLabEntity = z
  .object({ expected_version: i64, name: z.string(), placement: Placement })
  .strict()
  .openapi('CopyLabEntity');
export const EntityRelationship = z
  .object({
    id: z.string(),
    lab_id: z.string(),
    source_id: z.string(),
    target_id: z.string(),
    kind: z.string(),
    source: z.string(),
    registered_by: z.string(),
    registered_at: instant,
  })
  .openapi('EntityRelationship');
export const RelationshipKind = z
  .enum(['located_in', 'contains', 'simulates'])
  .openapi('RelationshipKind');
export const LayoutRelationship = z
  .object({
    id: z.string(),
    source_id: z.string(),
    target_id: z.string(),
    kind: RelationshipKind,
  })
  .strict()
  .openapi('LayoutRelationship');
export const LayoutNode = z
  .object({
    id: z.string(),
    entity_id: z.string(),
    representation_id: z.string().nullable().optional(),
    placement: Placement,
  })
  .strict()
  .openapi('LayoutNode');
export const SaveLabLayout = z
  .object({
    expected_version: i64,
    nodes: z.array(LayoutNode),
    relationships: z.array(LayoutRelationship).nullable().optional().openapi({
      description:
        'Omit to retain registered relationships; an array explicitly replaces them.',
    }),
  })
  .strict()
  .openapi('SaveLabLayout');
export const LabLayout = z
  .object({
    layout_version: i64,
    nodes: z.array(SceneNode),
    relationships: z.array(EntityRelationship),
  })
  .openapi('LabLayout');
export const LabWorld = z
  .object({
    version: z.string().openapi({
      description:
        'Deployment-wide committed world revision, compared only within the same Lab/query.',
    }),
    lab: PersistentLab,
    entities: z.array(LabEntity),
    nodes: z.array(SceneNode),
    assets: z.array(LabAsset),
    relationships: z.array(EntityRelationship),
  })
  .openapi('LabWorld');
