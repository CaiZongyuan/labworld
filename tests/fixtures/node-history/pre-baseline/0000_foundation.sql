CREATE SCHEMA "labos_threejs_core";
--> statement-breakpoint
CREATE SCHEMA "lab";
--> statement-breakpoint
CREATE TABLE "labos_threejs_core"."api_keys" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"user_id" uuid NOT NULL,
	"name" text NOT NULL,
	"prefix" text NOT NULL,
	"secret_hash" "bytea" NOT NULL,
	"scopes" text[] NOT NULL,
	"created_at" timestamp(6) with time zone DEFAULT now() NOT NULL,
	"expires_at" timestamp(6) with time zone NOT NULL,
	"revoked_at" timestamp(6) with time zone,
	"last_used_at" timestamp(6) with time zone,
	CONSTRAINT "api_keys_secret_hash_unique" UNIQUE("secret_hash"),
	CONSTRAINT "api_key_name" CHECK (length("labos_threejs_core"."api_keys"."name") BETWEEN 1 AND 100),
	CONSTRAINT "api_key_scopes" CHECK (cardinality("labos_threejs_core"."api_keys"."scopes") BETWEEN 1 AND 16)
);
--> statement-breakpoint
CREATE TABLE "labos_threejs_core"."audit_events" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"actor_id" uuid,
	"actor_type" text NOT NULL,
	"action" text NOT NULL,
	"resource_type" text NOT NULL,
	"resource_id" text NOT NULL,
	"request_id" text,
	"trace_id" text,
	"correlation_id" text NOT NULL,
	"metadata" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"created_at" timestamp(6) with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "audit_metadata_object" CHECK (jsonb_typeof("labos_threejs_core"."audit_events"."metadata") = 'object'),
	CONSTRAINT "audit_metadata_allowlist" CHECK ("labos_threejs_core"."audit_events"."metadata" - 'subject_user_id' = '{}'::jsonb)
);
--> statement-breakpoint
CREATE TABLE "labos_threejs_core"."file_candidates" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"file_id" uuid NOT NULL,
	"object_key" text NOT NULL,
	"state" text DEFAULT 'copying' NOT NULL,
	"last_error" text,
	"created_at" timestamp(6) with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp(6) with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "file_candidates_object_key_unique" UNIQUE("object_key"),
	CONSTRAINT "candidate_state" CHECK ("labos_threejs_core"."file_candidates"."state" IN ('copying','adopted','abandoned','deleted'))
);
--> statement-breakpoint
CREATE TABLE "labos_threejs_core"."file_cleanup_control" (
	"id" bigint PRIMARY KEY NOT NULL,
	"last_rescan_at" timestamp(6) with time zone,
	CONSTRAINT "file_cleanup_singleton" CHECK ("labos_threejs_core"."file_cleanup_control"."id" = 1)
);
--> statement-breakpoint
CREATE TABLE "labos_threejs_core"."files" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"created_by" uuid NOT NULL,
	"file_name" text NOT NULL,
	"content_type" text NOT NULL,
	"declared_size" bigint NOT NULL,
	"sha256" "bytea" NOT NULL,
	"state" text DEFAULT 'pending_upload' NOT NULL,
	"staging_key" text NOT NULL,
	"ready_key" text,
	"ready_candidate_id" uuid,
	"actual_size" bigint,
	"expires_at" timestamp(6) with time zone NOT NULL,
	"last_error" text,
	"next_cleanup_check_at" timestamp(6) with time zone DEFAULT now() NOT NULL,
	"created_at" timestamp(6) with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp(6) with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "files_staging_key_unique" UNIQUE("staging_key"),
	CONSTRAINT "files_ready_key_unique" UNIQUE("ready_key"),
	CONSTRAINT "files_ready_candidate_id_unique" UNIQUE("ready_candidate_id"),
	CONSTRAINT "file_size" CHECK ("labos_threejs_core"."files"."declared_size" >= 0),
	CONSTRAINT "file_hash" CHECK (octet_length("labos_threejs_core"."files"."sha256") = 32),
	CONSTRAINT "file_state" CHECK ("labos_threejs_core"."files"."state" IN ('pending_upload','ready','rejected','expired','deleting','deleted')),
	CONSTRAINT "ready_file" CHECK ("labos_threejs_core"."files"."state" <> 'ready' OR ("labos_threejs_core"."files"."ready_key" IS NOT NULL AND "labos_threejs_core"."files"."ready_candidate_id" IS NOT NULL AND "labos_threejs_core"."files"."actual_size" IS NOT NULL))
);
--> statement-breakpoint
CREATE TABLE "labos_threejs_core"."object_cleanup" (
	"object_key" text PRIMARY KEY NOT NULL,
	"file_id" uuid NOT NULL,
	"candidate_id" uuid,
	"first_deleted_at" timestamp(6) with time zone,
	"last_checked_at" timestamp(6) with time zone,
	"next_probe_at" timestamp(6) with time zone,
	"last_error" text
);
--> statement-breakpoint
CREATE TABLE "labos_threejs_core"."idempotency_records" (
	"actor_id" uuid NOT NULL,
	"scope" text NOT NULL,
	"request_key" text NOT NULL,
	"fingerprint" "bytea" NOT NULL,
	"response" jsonb,
	"expires_at" timestamp(6) with time zone DEFAULT now() + interval '24 hours' NOT NULL,
	CONSTRAINT "idempotency_records_actor_id_scope_request_key_pk" PRIMARY KEY("actor_id","scope","request_key")
);
--> statement-breakpoint
CREATE TABLE "labos_threejs_core"."credentials" (
	"user_id" uuid PRIMARY KEY NOT NULL,
	"password_hash" text NOT NULL
);
--> statement-breakpoint
CREATE TABLE "labos_threejs_core"."sessions" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"secret_hash" "bytea" NOT NULL,
	"user_id" uuid NOT NULL,
	"expires_at" timestamp(6) with time zone NOT NULL,
	"last_seen_at" timestamp(6) with time zone DEFAULT now() NOT NULL,
	"revoked" boolean DEFAULT false NOT NULL,
	CONSTRAINT "sessions_secret_hash_unique" UNIQUE("secret_hash")
);
--> statement-breakpoint
CREATE TABLE "labos_threejs_core"."users" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"email" text NOT NULL,
	"normalized_email" text NOT NULL,
	"display_name" text,
	"created_at" timestamp(6) with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "users_normalized_email_unique" UNIQUE("normalized_email")
);
--> statement-breakpoint
CREATE TABLE "labos_threejs_core"."memberships" (
	"user_id" uuid PRIMARY KEY NOT NULL,
	"organization_id" integer NOT NULL,
	"role" text NOT NULL,
	"active" boolean DEFAULT true NOT NULL,
	"version" bigint DEFAULT 1 NOT NULL,
	CONSTRAINT "membership_role" CHECK ("labos_threejs_core"."memberships"."role" IN ('owner','admin','member')),
	CONSTRAINT "membership_version" CHECK ("labos_threejs_core"."memberships"."version" > 0)
);
--> statement-breakpoint
CREATE TABLE "labos_threejs_core"."organizations" (
	"id" integer PRIMARY KEY NOT NULL,
	"name" text NOT NULL,
	"owner_initialized" boolean DEFAULT false NOT NULL,
	CONSTRAINT "single_organization" CHECK ("labos_threejs_core"."organizations"."id" = 1)
);
--> statement-breakpoint
CREATE TABLE "lab"."asset_uploads" (
	"upload_id" uuid PRIMARY KEY NOT NULL,
	"asset_id" uuid NOT NULL,
	"name" text NOT NULL,
	"source" text NOT NULL,
	"license" text NOT NULL,
	"version" text NOT NULL,
	"created_by" uuid NOT NULL,
	CONSTRAINT "asset_uploads_asset_id_unique" UNIQUE("asset_id")
);
--> statement-breakpoint
CREATE TABLE "lab"."assets" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"name" text NOT NULL,
	"source" text NOT NULL,
	"license" text NOT NULL,
	"version" text NOT NULL,
	"created_by" uuid NOT NULL,
	"updated_by" uuid NOT NULL,
	"created_at" timestamp(6) with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp(6) with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "asset_name" CHECK (length(btrim("lab"."assets"."name")) BETWEEN 1 AND 120)
);
--> statement-breakpoint
CREATE TABLE "lab"."asset_representations" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"asset_id" uuid NOT NULL,
	"file_id" uuid NOT NULL,
	"file_name" text NOT NULL,
	"size" bigint NOT NULL,
	"sha256" text NOT NULL,
	"content_type" text NOT NULL,
	CONSTRAINT "asset_representations_asset_id_unique" UNIQUE("asset_id"),
	CONSTRAINT "asset_representations_file_id_unique" UNIQUE("file_id")
);
--> statement-breakpoint
CREATE TABLE "lab"."runtime_bindings" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"entity_id" uuid NOT NULL,
	"program_id" text NOT NULL,
	"source" text NOT NULL,
	"current" boolean DEFAULT true NOT NULL,
	"definition_id" text NOT NULL,
	"definition_version" text NOT NULL,
	"definition" jsonb NOT NULL,
	CONSTRAINT "runtime_bindings_source_unique" UNIQUE("source")
);
--> statement-breakpoint
CREATE TABLE "lab"."command_receipts" (
	"actor_id" uuid NOT NULL,
	"entity_id" uuid NOT NULL,
	"request_key" text NOT NULL,
	"command_id" uuid NOT NULL,
	"fingerprint" text NOT NULL,
	CONSTRAINT "command_receipts_actor_id_entity_id_request_key_pk" PRIMARY KEY("actor_id","entity_id","request_key"),
	CONSTRAINT "command_receipts_command_id_unique" UNIQUE("command_id"),
	CONSTRAINT "receipt_fingerprint" CHECK (length("lab"."command_receipts"."fingerprint") = 64)
);
--> statement-breakpoint
CREATE TABLE "lab"."device_commands" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"entity_id" uuid NOT NULL,
	"run_id" uuid NOT NULL,
	"actor_id" uuid NOT NULL,
	"actor_source" text NOT NULL,
	"request_key" text NOT NULL,
	"capability" text NOT NULL,
	"parameters" jsonb NOT NULL,
	"status" text NOT NULL,
	"result" jsonb,
	"task_id" uuid,
	"created_at" timestamp(6) with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp(6) with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "command_actor_source" CHECK ("lab"."device_commands"."actor_source" IN ('member','agent')),
	CONSTRAINT "command_status" CHECK ("lab"."device_commands"."status" IN ('accepted','executing','succeeded','failed','unknown'))
);
--> statement-breakpoint
CREATE TABLE "lab"."current_observations" (
	"entity_id" uuid PRIMARY KEY NOT NULL,
	"run_id" uuid NOT NULL,
	"sequence" bigint NOT NULL,
	"source" text NOT NULL,
	"values" jsonb NOT NULL,
	"observed_at" timestamp(6) with time zone,
	"received_at" timestamp(6) with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp(6) with time zone DEFAULT now() NOT NULL,
	"quality" text NOT NULL,
	"properties" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"observed_times" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"freshness" text DEFAULT 'current' NOT NULL
);
--> statement-breakpoint
CREATE TABLE "lab"."program_runs" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"entity_id" uuid NOT NULL,
	"binding_id" uuid NOT NULL,
	"generation" bigint NOT NULL,
	"configuration" jsonb NOT NULL,
	"status" text NOT NULL,
	"started_by" uuid NOT NULL,
	"started_at" timestamp(6) with time zone DEFAULT now() NOT NULL,
	"ended_at" timestamp(6) with time zone,
	"sequence" bigint DEFAULT 0 NOT NULL,
	"last_observed_at" timestamp(6) with time zone,
	"next_sample_at" timestamp(6) with time zone,
	CONSTRAINT "run_status" CHECK ("lab"."program_runs"."status" IN ('running','stopped','interrupted'))
);
--> statement-breakpoint
CREATE TABLE "lab"."runtime_generation" (
	"singleton" boolean PRIMARY KEY DEFAULT true NOT NULL,
	"generation" bigint DEFAULT 0 NOT NULL,
	CONSTRAINT "runtime_singleton" CHECK ("lab"."runtime_generation"."singleton")
);
--> statement-breakpoint
CREATE TABLE "lab"."device_task_results" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"task_id" uuid NOT NULL,
	"status" text NOT NULL,
	"reason" text,
	"ended_at" timestamp(6) with time zone,
	CONSTRAINT "device_task_results_task_id_unique" UNIQUE("task_id"),
	CONSTRAINT "task_result_status" CHECK ("lab"."device_task_results"."status" IN ('pending','completed','cancelled','failed','unknown','interrupted'))
);
--> statement-breakpoint
CREATE TABLE "lab"."device_tasks" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"entity_id" uuid NOT NULL,
	"run_id" uuid NOT NULL,
	"command_id" uuid NOT NULL,
	"result_id" uuid NOT NULL,
	"parameters" jsonb NOT NULL,
	"status" text NOT NULL,
	"elapsed_seconds" double precision DEFAULT 0 NOT NULL,
	"timer_started_at" timestamp(6) with time zone,
	"last_tick_at" timestamp(6) with time zone,
	"pending_outcome" text,
	"created_at" timestamp(6) with time zone DEFAULT now() NOT NULL,
	"ended_at" timestamp(6) with time zone,
	CONSTRAINT "device_tasks_command_id_unique" UNIQUE("command_id"),
	CONSTRAINT "device_tasks_result_id_unique" UNIQUE("result_id"),
	CONSTRAINT "task_status" CHECK ("lab"."device_tasks"."status" IN ('pending','preparing','running','decelerating','completed','cancelled','failed','unknown','interrupted')),
	CONSTRAINT "task_elapsed" CHECK ("lab"."device_tasks"."elapsed_seconds" >= 0),
	CONSTRAINT "task_outcome" CHECK ("lab"."device_tasks"."pending_outcome" IN ('completed','cancelled','failed','unknown'))
);
--> statement-breakpoint
CREATE TABLE "lab"."device_events" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"entity_id" uuid NOT NULL,
	"run_id" uuid NOT NULL,
	"occurred_at" timestamp(6) with time zone NOT NULL,
	"received_at" timestamp(6) with time zone DEFAULT now() NOT NULL,
	"data" jsonb NOT NULL
);
--> statement-breakpoint
CREATE TABLE "lab"."observation_history" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"entity_id" uuid NOT NULL,
	"run_id" uuid NOT NULL,
	"observed_at" timestamp(6) with time zone,
	"received_at" timestamp(6) with time zone NOT NULL,
	"data" jsonb NOT NULL
);
--> statement-breakpoint
CREATE TABLE "lab"."history_bounds" (
	"entity_id" uuid NOT NULL,
	"record_type" text NOT NULL,
	"captured_since" timestamp(6) with time zone NOT NULL,
	"cleaned_before" timestamp(6) with time zone,
	CONSTRAINT "history_bounds_entity_id_record_type_pk" PRIMARY KEY("entity_id","record_type"),
	CONSTRAINT "history_type" CHECK ("lab"."history_bounds"."record_type" IN ('observation','command','task','event'))
);
--> statement-breakpoint
CREATE TABLE "lab"."entity_relationships" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"lab_id" uuid NOT NULL,
	"source_id" uuid NOT NULL,
	"target_id" uuid NOT NULL,
	"kind" text NOT NULL,
	"source" text DEFAULT 'manual' NOT NULL,
	"registered_by" uuid NOT NULL,
	"registered_at" timestamp(6) with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "relationship_unique" UNIQUE("lab_id","source_id","target_id","kind"),
	CONSTRAINT "relationship_kind" CHECK ("lab"."entity_relationships"."kind" IN ('located_in','contains','simulates')),
	CONSTRAINT "relationship_source" CHECK ("lab"."entity_relationships"."source" = 'manual'),
	CONSTRAINT "relationship_distinct" CHECK ("lab"."entity_relationships"."source_id" <> "lab"."entity_relationships"."target_id")
);
--> statement-breakpoint
CREATE TABLE "lab"."entities" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"lab_id" uuid NOT NULL,
	"name" text NOT NULL,
	"kind" text NOT NULL,
	"reality" text NOT NULL,
	"definition_id" text NOT NULL,
	"definition_version" text NOT NULL,
	"definition" jsonb NOT NULL,
	"configuration" jsonb NOT NULL,
	"representation_id" uuid,
	"created_by" uuid NOT NULL,
	"updated_by" uuid NOT NULL,
	"created_at" timestamp(6) with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp(6) with time zone DEFAULT now() NOT NULL,
	"archived_at" timestamp(6) with time zone,
	CONSTRAINT "entities_lab_identity" UNIQUE("lab_id","id"),
	CONSTRAINT "entity_name" CHECK (length(btrim("lab"."entities"."name")) BETWEEN 1 AND 120),
	CONSTRAINT "entity_reality" CHECK ("lab"."entities"."reality" IN ('simulated','physical'))
);
--> statement-breakpoint
CREATE TABLE "lab"."labs" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"name" text NOT NULL,
	"layout_version" bigint DEFAULT 0 NOT NULL,
	"created_by" uuid NOT NULL,
	"created_at" timestamp(6) with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "lab_name" CHECK (length(btrim("lab"."labs"."name")) BETWEEN 1 AND 120)
);
--> statement-breakpoint
CREATE TABLE "lab"."scene_nodes" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"lab_id" uuid NOT NULL,
	"entity_id" uuid NOT NULL,
	"representation_id" uuid,
	"placement" jsonb NOT NULL
);
--> statement-breakpoint
CREATE TABLE "lab"."world_clock" (
	"singleton" boolean PRIMARY KEY DEFAULT true NOT NULL,
	"version" bigint DEFAULT 0 NOT NULL,
	CONSTRAINT "world_singleton" CHECK ("lab"."world_clock"."singleton"),
	CONSTRAINT "world_version_nonnegative" CHECK ("lab"."world_clock"."version" >= 0)
);
--> statement-breakpoint
ALTER TABLE "labos_threejs_core"."api_keys" ADD CONSTRAINT "api_keys_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "labos_threejs_core"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "labos_threejs_core"."audit_events" ADD CONSTRAINT "audit_events_actor_id_users_id_fk" FOREIGN KEY ("actor_id") REFERENCES "labos_threejs_core"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "labos_threejs_core"."file_candidates" ADD CONSTRAINT "file_candidates_file_id_files_id_fk" FOREIGN KEY ("file_id") REFERENCES "labos_threejs_core"."files"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "labos_threejs_core"."files" ADD CONSTRAINT "files_created_by_users_id_fk" FOREIGN KEY ("created_by") REFERENCES "labos_threejs_core"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "labos_threejs_core"."object_cleanup" ADD CONSTRAINT "object_cleanup_file_id_files_id_fk" FOREIGN KEY ("file_id") REFERENCES "labos_threejs_core"."files"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "labos_threejs_core"."object_cleanup" ADD CONSTRAINT "object_cleanup_candidate_id_file_candidates_id_fk" FOREIGN KEY ("candidate_id") REFERENCES "labos_threejs_core"."file_candidates"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "labos_threejs_core"."idempotency_records" ADD CONSTRAINT "idempotency_records_actor_id_users_id_fk" FOREIGN KEY ("actor_id") REFERENCES "labos_threejs_core"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "labos_threejs_core"."credentials" ADD CONSTRAINT "credentials_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "labos_threejs_core"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "labos_threejs_core"."sessions" ADD CONSTRAINT "sessions_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "labos_threejs_core"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "labos_threejs_core"."memberships" ADD CONSTRAINT "memberships_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "labos_threejs_core"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "labos_threejs_core"."memberships" ADD CONSTRAINT "memberships_organization_id_organizations_id_fk" FOREIGN KEY ("organization_id") REFERENCES "labos_threejs_core"."organizations"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "lab"."asset_uploads" ADD CONSTRAINT "asset_uploads_upload_id_files_id_fk" FOREIGN KEY ("upload_id") REFERENCES "labos_threejs_core"."files"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "lab"."asset_uploads" ADD CONSTRAINT "asset_uploads_created_by_users_id_fk" FOREIGN KEY ("created_by") REFERENCES "labos_threejs_core"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "lab"."assets" ADD CONSTRAINT "assets_created_by_users_id_fk" FOREIGN KEY ("created_by") REFERENCES "labos_threejs_core"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "lab"."assets" ADD CONSTRAINT "assets_updated_by_users_id_fk" FOREIGN KEY ("updated_by") REFERENCES "labos_threejs_core"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "lab"."asset_representations" ADD CONSTRAINT "asset_representations_asset_id_assets_id_fk" FOREIGN KEY ("asset_id") REFERENCES "lab"."assets"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "lab"."asset_representations" ADD CONSTRAINT "asset_representations_file_id_files_id_fk" FOREIGN KEY ("file_id") REFERENCES "labos_threejs_core"."files"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "lab"."runtime_bindings" ADD CONSTRAINT "runtime_bindings_entity_id_entities_id_fk" FOREIGN KEY ("entity_id") REFERENCES "lab"."entities"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "lab"."command_receipts" ADD CONSTRAINT "command_receipts_actor_id_users_id_fk" FOREIGN KEY ("actor_id") REFERENCES "labos_threejs_core"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "lab"."command_receipts" ADD CONSTRAINT "command_receipts_entity_id_entities_id_fk" FOREIGN KEY ("entity_id") REFERENCES "lab"."entities"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "lab"."device_commands" ADD CONSTRAINT "device_commands_entity_id_entities_id_fk" FOREIGN KEY ("entity_id") REFERENCES "lab"."entities"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "lab"."device_commands" ADD CONSTRAINT "device_commands_run_id_program_runs_id_fk" FOREIGN KEY ("run_id") REFERENCES "lab"."program_runs"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "lab"."device_commands" ADD CONSTRAINT "device_commands_actor_id_users_id_fk" FOREIGN KEY ("actor_id") REFERENCES "labos_threejs_core"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "lab"."current_observations" ADD CONSTRAINT "current_observations_entity_id_entities_id_fk" FOREIGN KEY ("entity_id") REFERENCES "lab"."entities"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "lab"."current_observations" ADD CONSTRAINT "current_observations_run_id_program_runs_id_fk" FOREIGN KEY ("run_id") REFERENCES "lab"."program_runs"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "lab"."program_runs" ADD CONSTRAINT "program_runs_entity_id_entities_id_fk" FOREIGN KEY ("entity_id") REFERENCES "lab"."entities"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "lab"."program_runs" ADD CONSTRAINT "program_runs_binding_id_runtime_bindings_id_fk" FOREIGN KEY ("binding_id") REFERENCES "lab"."runtime_bindings"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "lab"."program_runs" ADD CONSTRAINT "program_runs_started_by_users_id_fk" FOREIGN KEY ("started_by") REFERENCES "labos_threejs_core"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "lab"."device_task_results" ADD CONSTRAINT "device_task_results_task_id_device_tasks_id_fk" FOREIGN KEY ("task_id") REFERENCES "lab"."device_tasks"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "lab"."device_tasks" ADD CONSTRAINT "device_tasks_entity_id_entities_id_fk" FOREIGN KEY ("entity_id") REFERENCES "lab"."entities"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "lab"."device_tasks" ADD CONSTRAINT "device_tasks_run_id_program_runs_id_fk" FOREIGN KEY ("run_id") REFERENCES "lab"."program_runs"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "lab"."device_events" ADD CONSTRAINT "device_events_entity_id_entities_id_fk" FOREIGN KEY ("entity_id") REFERENCES "lab"."entities"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "lab"."device_events" ADD CONSTRAINT "device_events_run_id_program_runs_id_fk" FOREIGN KEY ("run_id") REFERENCES "lab"."program_runs"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "lab"."observation_history" ADD CONSTRAINT "observation_history_entity_id_entities_id_fk" FOREIGN KEY ("entity_id") REFERENCES "lab"."entities"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "lab"."observation_history" ADD CONSTRAINT "observation_history_run_id_program_runs_id_fk" FOREIGN KEY ("run_id") REFERENCES "lab"."program_runs"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "lab"."history_bounds" ADD CONSTRAINT "history_bounds_entity_id_entities_id_fk" FOREIGN KEY ("entity_id") REFERENCES "lab"."entities"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "lab"."entity_relationships" ADD CONSTRAINT "entity_relationships_lab_id_labs_id_fk" FOREIGN KEY ("lab_id") REFERENCES "lab"."labs"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "lab"."entity_relationships" ADD CONSTRAINT "entity_relationships_registered_by_users_id_fk" FOREIGN KEY ("registered_by") REFERENCES "labos_threejs_core"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "lab"."entity_relationships" ADD CONSTRAINT "entity_relationships_lab_id_source_id_entities_lab_id_id_fk" FOREIGN KEY ("lab_id","source_id") REFERENCES "lab"."entities"("lab_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "lab"."entity_relationships" ADD CONSTRAINT "entity_relationships_lab_id_target_id_entities_lab_id_id_fk" FOREIGN KEY ("lab_id","target_id") REFERENCES "lab"."entities"("lab_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "lab"."entities" ADD CONSTRAINT "entities_lab_id_labs_id_fk" FOREIGN KEY ("lab_id") REFERENCES "lab"."labs"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "lab"."entities" ADD CONSTRAINT "entities_representation_id_asset_representations_id_fk" FOREIGN KEY ("representation_id") REFERENCES "lab"."asset_representations"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "lab"."entities" ADD CONSTRAINT "entities_created_by_users_id_fk" FOREIGN KEY ("created_by") REFERENCES "labos_threejs_core"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "lab"."entities" ADD CONSTRAINT "entities_updated_by_users_id_fk" FOREIGN KEY ("updated_by") REFERENCES "labos_threejs_core"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "lab"."labs" ADD CONSTRAINT "labs_created_by_users_id_fk" FOREIGN KEY ("created_by") REFERENCES "labos_threejs_core"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "lab"."scene_nodes" ADD CONSTRAINT "scene_nodes_lab_id_labs_id_fk" FOREIGN KEY ("lab_id") REFERENCES "lab"."labs"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "lab"."scene_nodes" ADD CONSTRAINT "scene_nodes_representation_id_asset_representations_id_fk" FOREIGN KEY ("representation_id") REFERENCES "lab"."asset_representations"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "lab"."scene_nodes" ADD CONSTRAINT "scene_nodes_lab_id_entity_id_entities_lab_id_id_fk" FOREIGN KEY ("lab_id","entity_id") REFERENCES "lab"."entities"("lab_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "api_keys_owner_history" ON "labos_threejs_core"."api_keys" USING btree ("user_id","id");--> statement-breakpoint
CREATE INDEX "audit_resource_history" ON "labos_threejs_core"."audit_events" USING btree ("resource_id","id");--> statement-breakpoint
CREATE INDEX "audit_action_history" ON "labos_threejs_core"."audit_events" USING btree ("action","id");--> statement-breakpoint
CREATE INDEX "audit_actor_history" ON "labos_threejs_core"."audit_events" USING btree ("actor_id","id");--> statement-breakpoint
CREATE INDEX "audit_request_history" ON "labos_threejs_core"."audit_events" USING btree ("request_id","id");--> statement-breakpoint
CREATE INDEX "audit_correlation_history" ON "labos_threejs_core"."audit_events" USING btree ("correlation_id","id");--> statement-breakpoint
CREATE INDEX "file_candidates_file" ON "labos_threejs_core"."file_candidates" USING btree ("file_id","id");--> statement-breakpoint
CREATE INDEX "files_cleanup" ON "labos_threejs_core"."files" USING btree ("state","expires_at","id");--> statement-breakpoint
CREATE INDEX "files_cleanup_check" ON "labos_threejs_core"."files" USING btree ("next_cleanup_check_at","id");--> statement-breakpoint
CREATE INDEX "object_cleanup_file" ON "labos_threejs_core"."object_cleanup" USING btree ("file_id","first_deleted_at");--> statement-breakpoint
CREATE INDEX "object_cleanup_probe" ON "labos_threejs_core"."object_cleanup" USING btree ("next_probe_at") WHERE "labos_threejs_core"."object_cleanup"."first_deleted_at" IS NOT NULL;--> statement-breakpoint
CREATE INDEX "idempotency_expiry" ON "labos_threejs_core"."idempotency_records" USING btree ("expires_at");--> statement-breakpoint
CREATE INDEX "sessions_user_id" ON "labos_threejs_core"."sessions" USING btree ("user_id");--> statement-breakpoint
CREATE UNIQUE INDEX "one_current_binding" ON "lab"."runtime_bindings" USING btree ("entity_id") WHERE "lab"."runtime_bindings"."current";--> statement-breakpoint
CREATE UNIQUE INDEX "command_request" ON "lab"."device_commands" USING btree ("actor_id","entity_id","request_key");--> statement-breakpoint
CREATE INDEX "pending_device_commands" ON "lab"."device_commands" USING btree ("created_at","id") WHERE "lab"."device_commands"."status" = 'accepted';--> statement-breakpoint
CREATE INDEX "device_commands_range" ON "lab"."device_commands" USING btree ("entity_id","created_at" DESC NULLS LAST,"id" DESC NULLS LAST);--> statement-breakpoint
CREATE UNIQUE INDEX "one_running_program" ON "lab"."program_runs" USING btree ("entity_id") WHERE "lab"."program_runs"."status" = 'running';--> statement-breakpoint
CREATE INDEX "program_runs_entity" ON "lab"."program_runs" USING btree ("entity_id","started_at" DESC NULLS LAST,"id" DESC NULLS LAST);--> statement-breakpoint
CREATE UNIQUE INDEX "one_active_device_task" ON "lab"."device_tasks" USING btree ("entity_id") WHERE "lab"."device_tasks"."status" IN ('pending','preparing','running','decelerating');--> statement-breakpoint
CREATE INDEX "device_tasks_entity" ON "lab"."device_tasks" USING btree ("entity_id","created_at" DESC NULLS LAST,"id" DESC NULLS LAST);--> statement-breakpoint
CREATE INDEX "device_events_range" ON "lab"."device_events" USING btree ("entity_id","received_at" DESC NULLS LAST,"id" DESC NULLS LAST);--> statement-breakpoint
CREATE INDEX "observation_history_range" ON "lab"."observation_history" USING btree ("entity_id","received_at" DESC NULLS LAST,"id" DESC NULLS LAST);--> statement-breakpoint
CREATE INDEX "entity_relationships_lab_id" ON "lab"."entity_relationships" USING btree ("lab_id","id");--> statement-breakpoint
CREATE INDEX "entities_lab_id" ON "lab"."entities" USING btree ("lab_id","id");--> statement-breakpoint
CREATE INDEX "scene_nodes_lab_id" ON "lab"."scene_nodes" USING btree ("lab_id","id");
--> statement-breakpoint
ALTER TABLE labos_threejs_core.files ADD FOREIGN KEY (ready_candidate_id) REFERENCES labos_threejs_core.file_candidates(id);
--> statement-breakpoint
ALTER TABLE lab.device_commands ADD FOREIGN KEY (task_id) REFERENCES lab.device_tasks(id) ON DELETE SET NULL;
--> statement-breakpoint
ALTER TABLE lab.device_tasks ADD FOREIGN KEY (result_id) REFERENCES lab.device_task_results(id) DEFERRABLE INITIALLY DEFERRED;
--> statement-breakpoint
INSERT INTO lab.world_clock DEFAULT VALUES;
--> statement-breakpoint
INSERT INTO lab.runtime_generation DEFAULT VALUES;
--> statement-breakpoint
INSERT INTO labos_threejs_core.file_cleanup_control(id) VALUES(1);

--> statement-breakpoint
CREATE FUNCTION lab.advance_world_version() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
    UPDATE lab.world_clock SET version = version + 1 WHERE singleton;
    RETURN NULL;
END;
$$;

--> statement-breakpoint
CREATE TRIGGER world_version BEFORE INSERT OR UPDATE OR DELETE ON lab.labs
    FOR EACH STATEMENT EXECUTE FUNCTION lab.advance_world_version();
--> statement-breakpoint
CREATE TRIGGER world_version BEFORE INSERT OR UPDATE OR DELETE ON lab.entities
    FOR EACH STATEMENT EXECUTE FUNCTION lab.advance_world_version();
--> statement-breakpoint
CREATE TRIGGER world_version BEFORE INSERT OR UPDATE OR DELETE ON lab.scene_nodes
    FOR EACH STATEMENT EXECUTE FUNCTION lab.advance_world_version();
--> statement-breakpoint
CREATE TRIGGER world_version BEFORE INSERT OR UPDATE OR DELETE ON lab.entity_relationships
    FOR EACH STATEMENT EXECUTE FUNCTION lab.advance_world_version();
--> statement-breakpoint
CREATE TRIGGER world_version BEFORE INSERT OR UPDATE OR DELETE ON lab.runtime_bindings
    FOR EACH STATEMENT EXECUTE FUNCTION lab.advance_world_version();
--> statement-breakpoint
CREATE TRIGGER world_version BEFORE INSERT OR UPDATE OR DELETE ON lab.program_runs
    FOR EACH STATEMENT EXECUTE FUNCTION lab.advance_world_version();
--> statement-breakpoint
CREATE TRIGGER world_version BEFORE INSERT OR UPDATE OR DELETE ON lab.current_observations
    FOR EACH STATEMENT EXECUTE FUNCTION lab.advance_world_version();
--> statement-breakpoint
CREATE TRIGGER world_version BEFORE INSERT OR UPDATE OR DELETE ON lab.assets
    FOR EACH STATEMENT EXECUTE FUNCTION lab.advance_world_version();
--> statement-breakpoint
CREATE TRIGGER world_version BEFORE INSERT OR UPDATE OR DELETE ON lab.asset_representations
    FOR EACH STATEMENT EXECUTE FUNCTION lab.advance_world_version();

--> statement-breakpoint
CREATE TRIGGER world_version BEFORE INSERT OR UPDATE OR DELETE ON lab.device_tasks FOR EACH STATEMENT EXECUTE FUNCTION lab.advance_world_version();

--> statement-breakpoint
CREATE TRIGGER world_version BEFORE INSERT OR UPDATE OR DELETE ON lab.device_task_results FOR EACH STATEMENT EXECUTE FUNCTION lab.advance_world_version();

--> statement-breakpoint
CREATE FUNCTION lab.initialize_history_bounds() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
    INSERT INTO lab.history_bounds(entity_id,record_type,captured_since)
    SELECT NEW.id,kind,NEW.created_at FROM (VALUES ('observation'),('command'),('task'),('event')) k(kind);
    RETURN NEW;
END $$;
--> statement-breakpoint
CREATE TRIGGER initialize_history_bounds AFTER INSERT ON lab.entities
    FOR EACH ROW EXECUTE FUNCTION lab.initialize_history_bounds();

--> statement-breakpoint
CREATE FUNCTION lab.append_device_event() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE
    kind text;
    at timestamptz;
    actor uuid;
    actor_source text;
    run uuid;
BEGIN
    IF TG_OP='UPDATE' AND OLD.status=NEW.status THEN RETURN NEW; END IF;
    IF TG_TABLE_NAME='program_runs' THEN
        kind:='program'; run:=NEW.id; actor:=NEW.started_by;
        at:=COALESCE(NEW.ended_at,NEW.started_at);
    ELSIF TG_TABLE_NAME='device_commands' THEN
        kind:='command'; run:=NEW.run_id; actor:=NEW.actor_id; actor_source:=NEW.actor_source;
        at:=NEW.updated_at;
    ELSE
        kind:='task'; run:=NEW.run_id;
        SELECT c.actor_id,c.actor_source INTO actor,actor_source FROM lab.device_commands c WHERE c.id=NEW.command_id;
        at:=COALESCE(NEW.ended_at,now());
    END IF;
    INSERT INTO lab.device_events(entity_id,run_id,occurred_at,data)
    VALUES(NEW.entity_id,run,at,jsonb_build_object('record_type',kind,'record_id',NEW.id,
        'status',NEW.status,'actor_id',actor,'actor_source',actor_source));
    RETURN NEW;
END $$;
--> statement-breakpoint
CREATE TRIGGER append_device_event AFTER INSERT OR UPDATE ON lab.program_runs
    FOR EACH ROW EXECUTE FUNCTION lab.append_device_event();
--> statement-breakpoint
CREATE TRIGGER append_device_event AFTER INSERT OR UPDATE ON lab.device_commands
    FOR EACH ROW EXECUTE FUNCTION lab.append_device_event();
--> statement-breakpoint
CREATE TRIGGER append_device_event AFTER INSERT OR UPDATE ON lab.device_tasks
    FOR EACH ROW EXECUTE FUNCTION lab.append_device_event();

