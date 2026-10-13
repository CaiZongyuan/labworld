import { z } from '@hono/zod-openapi';

export const SourcePhase = z.enum(['initializing', 'ready']);
export const LabSource = z
  .object({
    id: z.string().uuid(),
    lab_id: z.string().uuid(),
    name: z.string(),
    connection_state: z.enum(['offline', 'connected']),
    phase: SourcePhase.nullable(),
    authorization: z.enum(['unconfigured', 'authorized', 'expired', 'revoked']),
    credential_expires_at: z.string().nullable(),
    source_run_id: z.string().uuid().nullable(),
    connection_id: z.string().uuid().nullable(),
    epoch: z.string(),
    last_seen_at: z.string().nullable(),
    created_at: z.string(),
  })
  .openapi('LabSource');
export const LabSourcePage = z
  .object({ data: z.array(LabSource) })
  .openapi('LabSourcePage');
export const RegisterLabSource = z
  .object({ name: z.string().trim().min(1).max(120) })
  .strict()
  .openapi('RegisterLabSource');
export const LabSourceConfiguration = z
  .object({
    format: z.literal('lab-world-source-v1'),
    server_url: z.string(),
    lab_id: z.string().uuid(),
    source_id: z.string().uuid(),
    machine_id: z.string().uuid(),
    credential: z.string(),
    expires_at: z.string(),
  })
  .openapi('LabSourceConfiguration');
export const ConnectLabSource = z
  .object({
    machine_id: z.string().uuid(),
    source_run_id: z.string().uuid(),
    phase: SourcePhase,
  })
  .strict()
  .openapi('ConnectLabSource');
export const LabSourceHeartbeat = z
  .object({
    machine_id: z.string().uuid(),
    connection_id: z.string().uuid(),
    epoch: z.string().regex(/^(0|[1-9][0-9]{0,19})$/),
    phase: SourcePhase,
  })
  .strict()
  .openapi('LabSourceHeartbeat');
export const LabSourceConnection = z
  .object({
    connection_id: z.string().uuid(),
    epoch: z.string(),
    heartbeat_interval_ms: z.number().int(),
  })
  .openapi('LabSourceConnection');
export const DisconnectLabSource = LabSourceHeartbeat.omit({
  phase: true,
}).openapi('DisconnectLabSource');
export type Source = z.infer<typeof LabSource>;
export type SourceConnectionInput = z.infer<typeof ConnectLabSource>;
export type SourceHeartbeatInput = z.infer<typeof LabSourceHeartbeat>;
export type SourceDisconnectInput = z.infer<typeof DisconnectLabSource>;
