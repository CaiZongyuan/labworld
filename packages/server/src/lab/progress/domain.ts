export const guideId = 'lab-onboarding';
export const guideVersion = '1.0';
export const guideProgressLimits = {
  requestBytes: 8192,
  contextBytes: 4096,
  readSqlStatements: 6,
  saveSqlStatements: 8,
  readBytes: 12288,
  saveBytes: 6144,
} as const;
export const guideStatuses = [
  'not_started',
  'in_progress',
  'paused',
  'completed',
] as const;
export const guideSteps = [
  'create_lab',
  'register_light',
  'select_entity',
  'edit_placement',
  'save_layout',
  'return_run',
  'start_program',
  'light_action',
  'verify_observation',
  'asset_library',
  'complete',
] as const;
export type GuideContext = {
  lab_id: string | null;
  entity_id: string | null;
  node_id: string | null;
  business_attempt: {
    operation: 'create_lab' | 'register_entity';
    target_lab_id: string | null;
    request_key: string;
  } | null;
};
export type GuideProgress = {
  guide_id: string;
  guide_version: string;
  revision: number;
  status: (typeof guideStatuses)[number];
  step: string | null;
  guide_attempt_id: string | null;
  context: GuideContext | null;
  updated_at: string | null;
};
export type SaveProgress = {
  expected_revision: number;
  status: GuideProgress['status'];
  step: (typeof guideSteps)[number] | null;
  guide_attempt_id: string | null;
  context: GuideContext | null;
};
