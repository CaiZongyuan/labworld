import type { FoundationContext } from '../../platform/context.ts';
import { sql } from '../../platform/db/index.ts';
import { PublicFailure } from '../../platform/http/failure.ts';
import type { AuthPolicy } from '../../core/identity/domain.ts';
import { accessIn } from '../../core/api-keys/authentication.ts';
import { databaseAudit } from '../../core/audit/use-cases.ts';
import { loadLab } from './use-cases.ts';
import { worldId } from './entities.ts';
import { validPlacement, type Placement, type SceneNode } from './domain.ts';
import {
  loadRelationships,
  saveRelationships,
} from '../relationships/use-cases.ts';
import type { LayoutRelationship } from '../relationships/domain.ts';
export type LayoutNode = {
  id: string;
  entity_id: string;
  representation_id?: string | null;
  placement: Placement;
};
export type SaveLabLayout = {
  expected_version: number;
  nodes: LayoutNode[];
  relationships?: LayoutRelationship[] | null;
};
export async function saveLayout(
  context: FoundationContext,
  policy: AuthPolicy,
  headers: Headers,
  requestId: string,
  labId: string,
  input: SaveLabLayout,
) {
  try {
    return await context.db.transaction(
      { id: requestId, kind: 'request' },
      async (tx) => {
        const actor = await accessIn(
            tx,
            context,
            policy,
            headers,
            'lab:full',
            true,
          ),
          lab = worldId(labId);
        if (
          !Number.isInteger(input.expected_version) ||
          input.expected_version < 0 ||
          input.nodes.length > 1000
        )
          throw new PublicFailure(
            400,
            'lab.invalid_input',
            'Use an existing layout version and at most 1000 Nodes',
          );
        const nodes = input.nodes.map((node) => ({
          ...node,
          id: worldId(node.id),
          entity_id: worldId(node.entity_id),
          representation_id:
            node.representation_id == null
              ? null
              : worldId(node.representation_id),
        }));
        const identities = new Map<string, string>(),
          entities = new Set<string>(),
          representations = new Set<string>();
        for (const node of nodes) {
          if (identities.has(node.id) || !validPlacement(node.placement))
            throw new PublicFailure(
              400,
              'lab.invalid_input',
              'Use distinct Node identities and legal Placement',
            );
          identities.set(node.id, node.entity_id);
          entities.add(node.entity_id);
          if (node.representation_id)
            representations.add(node.representation_id);
        }
        const current = await loadLab(tx, lab);
        if (current.layout_version !== input.expected_version)
          throw new PublicFailure(
            409,
            'lab.layout_conflict',
            'Layout changed; keep the draft, reload the current version and retry',
          );
        if (input.relationships != null)
          await saveRelationships(tx, lab, actor.user.id, input.relationships);
        const entityIds = JSON.stringify([...entities]),
          representationIds = JSON.stringify([...representations]),
          nodeIds = JSON.stringify([...identities.keys()]);
        const found = await tx.execute<{ id: string }>(
          sql`select id::text from lab.entities where lab_id=${lab}::uuid and id in(select value::uuid from jsonb_array_elements_text(${entityIds}::jsonb))`,
        );
        const foundRepresentations = await tx.execute(
          sql`select id from lab.asset_representations where id in(select value::uuid from jsonb_array_elements_text(${representationIds}::jsonb))`,
        );
        if (
          found.rows.length !== entities.size ||
          foundRepresentations.rows.length !== representations.size
        )
          throw new PublicFailure(
            400,
            'lab.invalid_reference',
            'Use Entities in this Lab and existing representations',
          );
        const existing = await tx.execute<{
          id: string;
          lab_id: string;
          entity_id: string;
        }>(
          sql`select id::text,lab_id::text,entity_id::text from lab.scene_nodes where id in(select value::uuid from jsonb_array_elements_text(${nodeIds}::jsonb))`,
        );
        if (
          existing.rows.some(
            (node) =>
              node.lab_id !== lab || identities.get(node.id) !== node.entity_id,
          )
        )
          throw new PublicFailure(
            400,
            'lab.invalid_reference',
            'An existing Node cannot change Lab or Entity identity',
          );
        await tx.execute(
          sql`delete from lab.scene_nodes where lab_id=${lab}::uuid`,
        );
        await tx.execute(
          sql`insert into lab.scene_nodes(id,lab_id,entity_id,representation_id,placement) select n.id::uuid,${lab}::uuid,n.entity_id::uuid,n.representation_id::uuid,n.placement from jsonb_to_recordset(${JSON.stringify(nodes)}::jsonb) as n(id text,entity_id text,representation_id text,placement jsonb)`,
        );
        const version = await tx.execute<{ layout_version: number }>(
          sql`update lab.labs set layout_version=layout_version+1 where id=${lab}::uuid returning layout_version`,
        );
        await databaseAudit.record(tx, {
          actorId: actor.user.id,
          actorType: actor.isApiKey ? 'agent' : 'user',
          action: 'lab.layout.save',
          resourceType: 'lab.world',
          resourceId: lab,
          requestId,
          correlationId: requestId,
          metadata: {},
        });
        return {
          layout_version: Number(version.rows[0].layout_version),
          nodes: nodes.map((node) => ({ ...node, lab_id: lab })) as SceneNode[],
          relationships: await loadRelationships(tx, lab),
        };
      },
    );
  } catch (error) {
    if (error instanceof PublicFailure) throw error;
    let cause: unknown = error;
    while (cause && typeof cause === 'object') {
      if (
        'constraint' in cause &&
        cause.constraint === 'session_objects_node_id_scene_nodes_id_fk'
      )
        throw new PublicFailure(
          409,
          'lab.session_in_use',
          'An active Session owns this Scene Node',
        );
      cause = 'cause' in cause ? cause.cause : undefined;
    }
    throw new PublicFailure(
      503,
      'lab.unavailable',
      'Lab is temporarily unavailable',
    );
  }
}
