import { z } from '@hono/zod-openapi';
import { guideStatuses, guideSteps } from './domain.ts';

export const LabGuideStatus = z.enum(guideStatuses).openapi('LabGuideStatus');
export const LabGuideStep = z.enum(guideSteps).openapi('LabGuideStep');
export const GuideBusinessOperation = z
  .enum(['create_lab', 'register_entity'])
  .openapi('GuideBusinessOperation');
export const GuideBusinessAttempt = z
  .object({
    operation: GuideBusinessOperation,
    target_lab_id: z.uuid().nullable().default(null),
    request_key: z
      .string()
      .min(1)
      .max(128)
      .regex(/^[!-~]+$/),
  })
  .strict()
  .openapi('GuideBusinessAttempt');
export const LabGuideContext = z
  .object({
    lab_id: z.uuid().nullable().default(null),
    entity_id: z.uuid().nullable().default(null),
    node_id: z.uuid().nullable().default(null),
    business_attempt: GuideBusinessAttempt.nullable().default(null),
  })
  .strict()
  .openapi('LabGuideContext');
export const SaveLabGuideProgress = z
  .object({
    expected_revision: z
      .number()
      .int()
      .min(0)
      .max(Number.MAX_SAFE_INTEGER - 1),
    status: LabGuideStatus,
    step: LabGuideStep.nullable(),
    guide_attempt_id: z.uuid().nullable(),
    context: LabGuideContext.nullable(),
  })
  .strict()
  .openapi('SaveLabGuideProgress');
export const LabGuideProgress = z
  .object({
    guide_id: z.string(),
    guide_version: z.string(),
    revision: z.number().int().min(0).max(Number.MAX_SAFE_INTEGER),
    status: LabGuideStatus,
    step: z.string().nullable(),
    guide_attempt_id: z.uuid().nullable(),
    context: LabGuideContext.nullable(),
    updated_at: z.iso.datetime().nullable(),
  })
  .openapi('LabGuideProgress');
export const LabGuideCompatibility = z
  .enum(['compatible', 'restart_required', 'unsupported'])
  .openapi('LabGuideCompatibility');
export const LabGuideProgressRead = z
  .object({
    current_guide_version: z.string(),
    compatibility: LabGuideCompatibility,
    progress: LabGuideProgress,
    previous_progress: z.union([LabGuideProgress, z.null()]),
  })
  .openapi('LabGuideProgressRead');
