CREATE TABLE "lab"."recording_event_commits" (
	"recording_id" uuid NOT NULL,
	"batch_id" uuid NOT NULL,
	"first_event_sequence" numeric(20, 0) NOT NULL,
	"event_count" integer NOT NULL,
	"sha256" text NOT NULL,
	"committed_at" timestamp(6) with time zone NOT NULL,
	CONSTRAINT "recording_event_commits_recording_id_batch_id_pk" PRIMARY KEY("recording_id","batch_id"),
	CONSTRAINT "recording_event_count" CHECK ("lab"."recording_event_commits"."event_count" between 1 and 256)
);
--> statement-breakpoint
CREATE TABLE "lab"."recording_resources" (
	"recording_id" uuid NOT NULL,
	"file_id" uuid NOT NULL,
	"role" text NOT NULL,
	CONSTRAINT "recording_resources_recording_id_file_id_pk" PRIMARY KEY("recording_id","file_id")
);
--> statement-breakpoint
CREATE TABLE "lab"."recording_segments" (
	"id" uuid PRIMARY KEY NOT NULL,
	"recording_id" uuid NOT NULL,
	"index" integer NOT NULL,
	"file_id" uuid NOT NULL,
	"size" integer NOT NULL,
	"sha256" text NOT NULL,
	"first_ordinal" numeric(20, 0) NOT NULL,
	"last_ordinal" numeric(20, 0) NOT NULL,
	CONSTRAINT "recording_segment_size" CHECK ("lab"."recording_segments"."size">0)
);
--> statement-breakpoint
CREATE TABLE "lab"."recording_stages" (
	"id" uuid PRIMARY KEY NOT NULL,
	"session_id" uuid NOT NULL,
	"lab_id" uuid NOT NULL,
	"created_by" uuid NOT NULL,
	"manifest_file_id" uuid,
	"manifest_sha256" text,
	"charged_bytes" bigint NOT NULL,
	"created_at" timestamp(6) with time zone NOT NULL,
	"header_synced" boolean DEFAULT false NOT NULL,
	CONSTRAINT "recording_stages_session_id_unique" UNIQUE("session_id")
);
--> statement-breakpoint
CREATE TABLE "lab"."recordings" (
	"id" uuid PRIMARY KEY NOT NULL,
	"session_id" uuid NOT NULL,
	"lab_id" uuid NOT NULL,
	"created_by" uuid NOT NULL,
	"snapshot_hash" text NOT NULL,
	"manifest_file_id" uuid,
	"manifest_sha256" text,
	"capture_entity_ids" jsonb NOT NULL,
	"status" text DEFAULT 'preparing' NOT NULL,
	"reason" text,
	"started_at" timestamp(6) with time zone NOT NULL,
	"ended_at" timestamp(6) with time zone,
	"event_sequence" numeric(20, 0) DEFAULT '0' NOT NULL,
	"checkpoint" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"charged_bytes" bigint DEFAULT 0 NOT NULL,
	CONSTRAINT "recordings_session_id_unique" UNIQUE("session_id"),
	CONSTRAINT "recording_status" CHECK ("lab"."recordings"."status" in ('preparing','open','complete','incomplete','deleting','deleted')),
	CONSTRAINT "recording_event_sequence" CHECK ("lab"."recordings"."event_sequence" between 0 and 18446744073709551615),
	CONSTRAINT "recording_charge" CHECK ("lab"."recordings"."charged_bytes">=0)
);
--> statement-breakpoint
ALTER TABLE "lab"."recording_event_commits" ADD CONSTRAINT "recording_event_commits_recording_id_recordings_id_fk" FOREIGN KEY ("recording_id") REFERENCES "lab"."recordings"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "lab"."recording_resources" ADD CONSTRAINT "recording_resources_recording_id_recordings_id_fk" FOREIGN KEY ("recording_id") REFERENCES "lab"."recordings"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "lab"."recording_resources" ADD CONSTRAINT "recording_resources_file_id_files_id_fk" FOREIGN KEY ("file_id") REFERENCES "labos_threejs_core"."files"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "lab"."recording_segments" ADD CONSTRAINT "recording_segments_recording_id_recordings_id_fk" FOREIGN KEY ("recording_id") REFERENCES "lab"."recordings"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "lab"."recording_segments" ADD CONSTRAINT "recording_segments_file_id_files_id_fk" FOREIGN KEY ("file_id") REFERENCES "labos_threejs_core"."files"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "lab"."recording_stages" ADD CONSTRAINT "recording_stages_lab_id_labs_id_fk" FOREIGN KEY ("lab_id") REFERENCES "lab"."labs"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "lab"."recording_stages" ADD CONSTRAINT "recording_stages_created_by_users_id_fk" FOREIGN KEY ("created_by") REFERENCES "labos_threejs_core"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "lab"."recording_stages" ADD CONSTRAINT "recording_stages_manifest_file_id_files_id_fk" FOREIGN KEY ("manifest_file_id") REFERENCES "labos_threejs_core"."files"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "lab"."recordings" ADD CONSTRAINT "recordings_session_id_simulation_sessions_id_fk" FOREIGN KEY ("session_id") REFERENCES "lab"."simulation_sessions"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "lab"."recordings" ADD CONSTRAINT "recordings_lab_id_labs_id_fk" FOREIGN KEY ("lab_id") REFERENCES "lab"."labs"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "lab"."recordings" ADD CONSTRAINT "recordings_created_by_users_id_fk" FOREIGN KEY ("created_by") REFERENCES "labos_threejs_core"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "lab"."recordings" ADD CONSTRAINT "recordings_manifest_file_id_files_id_fk" FOREIGN KEY ("manifest_file_id") REFERENCES "labos_threejs_core"."files"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "recording_event_first" ON "lab"."recording_event_commits" USING btree ("recording_id","first_event_sequence");--> statement-breakpoint
CREATE UNIQUE INDEX "recording_segment_index" ON "lab"."recording_segments" USING btree ("recording_id","index");
--> statement-breakpoint
CREATE OR REPLACE FUNCTION lab.append_device_event() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE
    kind text;
    at timestamptz;
    actor uuid;
    actor_source text;
    run uuid;
BEGIN
    IF current_setting('lab.recording_apply',true)='on' THEN RETURN NEW; END IF;
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
