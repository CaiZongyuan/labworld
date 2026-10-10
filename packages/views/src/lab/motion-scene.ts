import { Euler, Quaternion, Vector3, type Object3D } from 'three';
import type { MotionBuffer, Placement } from '@labos-threejs/sdk';

/** Owns transient node-root transforms, independently of saved Placement and GLB pivots. */
export class MotionSceneController {
  private nodes = new Map<
    string,
    {
      entityId: string;
      object: Object3D;
      placement: Placement;
      displayed?: { sequence: string; sim_time_ns: string };
    }
  >();
  private position = new Vector3();
  private quaternion = new Quaternion();
  private parentQuaternion = new Quaternion();
  private euler = new Euler();
  private active = new Set<string>();
  private welcome: MotionBuffer['welcome'] = null;
  private renderedAt = 0;

  register(
    nodeId: string,
    entityId: string,
    object: Object3D,
    placement: Placement,
  ) {
    if (this.active.has(nodeId)) this.restore(nodeId);
    const association = { entityId, object, placement };
    this.nodes.set(nodeId, association);
    this.restore(nodeId);
    return () => {
      const entry = this.nodes.get(nodeId);
      if (entry !== association) return;
      if (this.active.has(nodeId)) this.restore(nodeId);
      this.nodes.delete(nodeId);
    };
  }

  update(buffer: MotionBuffer | null, now: number) {
    const welcome = buffer?.welcome ?? null;
    if (welcome !== this.welcome) {
      this.reset();
      this.welcome = welcome;
    }
    const sample = buffer?.sample(now);
    if (!welcome || !sample) return;
    this.renderedAt = now;
    const sequence = sample.sequence.toString();
    const simTime = sample.sim_time_ns.toString();
    for (let i = 0; i < welcome.pose_keys.length; i++) {
      const target = welcome.targets[i];
      const entry = target && this.nodes.get(target.node_id);
      if (
        !entry ||
        entry.entityId !== target.entity_id ||
        target.pose_key !== welcome.pose_keys[i]
      )
        continue;
      const object = entry.object;
      this.position.fromArray(sample.poses[i].position);
      this.quaternion.fromArray(sample.poses[i].quaternion).normalize();
      if (object.parent) {
        object.parent.updateWorldMatrix(true, false);
        object.parent.worldToLocal(this.position);
        object.parent.getWorldQuaternion(this.parentQuaternion);
        this.quaternion.premultiply(this.parentQuaternion.invert());
      }
      object.position.copy(this.position);
      object.quaternion.copy(this.quaternion);
      object.updateMatrix();
      object.updateWorldMatrix(false, true);
      // Provenance describes the pose actually displayed, rather than frame arrival rate.
      const provenance = (entry.displayed ??= {
        sequence,
        sim_time_ns: simTime,
      });
      provenance.sequence = sequence;
      provenance.sim_time_ns = simTime;
      this.active.add(target.node_id);
    }
  }

  reset() {
    for (const id of this.active) this.restore(id);
    this.active.clear();
    this.welcome = null;
    this.renderedAt = 0;
  }

  /** Read actual displayed Object3Ds without sampling or advancing the receive buffer. */
  inspect() {
    const welcome = this.welcome;
    if (!welcome || !this.active.size) return null;
    return {
      session_id: welcome.session_id,
      scene_hash: welcome.scene_hash,
      epoch: welcome.epoch,
      mapping_revision: welcome.mapping_revision,
      rendered_at_ms: this.renderedAt,
      nodes: welcome.targets.flatMap((target) => {
        const entry = this.nodes.get(target.node_id);
        if (!entry?.displayed) return [];
        return [
          {
            node_id: target.node_id,
            entity_id: target.entity_id,
            pose_key: target.pose_key,
            position: entry.object.getWorldPosition(new Vector3()).toArray(),
            quaternion: entry.object
              .getWorldQuaternion(new Quaternion())
              .toArray(),
            sequence: entry.displayed.sequence,
            sim_time_ns: entry.displayed.sim_time_ns,
          },
        ];
      }),
    };
  }

  private restore(id: string) {
    const entry = this.nodes.get(id);
    if (!entry) return;
    const { object, placement } = entry;
    object.position.fromArray(placement.position);
    object.quaternion.setFromEuler(
      this.euler.set(
        placement.rotation[0],
        placement.rotation[1],
        placement.rotation[2],
      ),
    );
    object.scale.fromArray(placement.scale);
    object.updateMatrix();
    object.updateWorldMatrix(false, true);
    delete entry.displayed;
    this.active.delete(id);
  }
}

export type MotionDiagnosticCanvas = HTMLCanvasElement & {
  getMotionDiagnostics?: () => ReturnType<MotionSceneController['inspect']>;
};
