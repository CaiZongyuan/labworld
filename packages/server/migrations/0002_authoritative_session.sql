CREATE TABLE "labos_threejs_core"."machines" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"name" text NOT NULL,
	"credential_hash" text NOT NULL,
	"created_by" uuid NOT NULL,
	"created_at" timestamp(6) with time zone DEFAULT now() NOT NULL,
	"expires_at" timestamp(6) with time zone NOT NULL,
	"revoked_at" timestamp(6) with time zone,
	CONSTRAINT "machines_credential_hash_unique" UNIQUE("credential_hash"),
	CONSTRAINT "machine_name" CHECK (length(btrim("labos_threejs_core"."machines"."name")) between 1 and 120)
);
--> statement-breakpoint
CREATE TABLE "lab"."scene_installations" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"lab_id" uuid NOT NULL,
	"metadata" jsonb NOT NULL,
	"created_by" uuid NOT NULL,
	"created_at" timestamp(6) with time zone DEFAULT now() NOT NULL,
	"archived_at" timestamp(6) with time zone
);
--> statement-breakpoint
CREATE TABLE "lab"."publisher_epoch" (
	"singleton" boolean PRIMARY KEY DEFAULT true NOT NULL,
	"value" numeric(20, 0) DEFAULT '0' NOT NULL,
	CONSTRAINT "publisher_epoch_singleton" CHECK ("lab"."publisher_epoch"."singleton"),
	CONSTRAINT "publisher_counter_u64" CHECK ("lab"."publisher_epoch"."value" between 0 and 18446744073709551615)
);
--> statement-breakpoint
CREATE TABLE "lab"."publisher_leases" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"session_id" uuid NOT NULL,
	"machine_id" uuid NOT NULL,
	"epoch" numeric(20, 0) NOT NULL,
	"admitted_at" timestamp(6) with time zone DEFAULT now() NOT NULL,
	"ended_at" timestamp(6) with time zone,
	CONSTRAINT "publisher_leases_epoch_unique" UNIQUE("epoch"),
	CONSTRAINT "publisher_epoch_u64" CHECK ("lab"."publisher_leases"."epoch" between 1 and 18446744073709551615)
);
--> statement-breakpoint
CREATE TABLE "lab"."session_assets" (
	"session_id" uuid NOT NULL,
	"representation_id" uuid NOT NULL,
	"file_id" uuid NOT NULL,
	CONSTRAINT "session_assets_session_id_representation_id_pk" PRIMARY KEY("session_id","representation_id")
);
--> statement-breakpoint
CREATE TABLE "lab"."session_objects" (
	"session_id" uuid NOT NULL,
	"node_id" uuid NOT NULL,
	"entity_id" uuid NOT NULL,
	CONSTRAINT "session_objects_session_id_node_id_pk" PRIMARY KEY("session_id","node_id")
);
--> statement-breakpoint
CREATE TABLE "lab"."simulation_sessions" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"lab_id" uuid NOT NULL,
	"installation_id" uuid NOT NULL,
	"machine_id" uuid NOT NULL,
	"snapshot" jsonb NOT NULL,
	"status" text NOT NULL,
	"revision" integer DEFAULT 0 NOT NULL,
	"epoch" numeric(20, 0),
	"lease_id" uuid,
	"started_by" uuid NOT NULL,
	"started_at" timestamp(6) with time zone DEFAULT now() NOT NULL,
	"ended_at" timestamp(6) with time zone,
	"reason" text,
	"successor_session_id" uuid,
	CONSTRAINT "simulation_session_status" CHECK ("lab"."simulation_sessions"."status" in ('starting','running','pausing','paused','resuming','stopping','stopped','interrupted','reset')),
	CONSTRAINT "simulation_session_revision" CHECK ("lab"."simulation_sessions"."revision" >= 0),
	CONSTRAINT "simulation_session_epoch" CHECK ("lab"."simulation_sessions"."epoch" between 1 and 18446744073709551615)
);
--> statement-breakpoint
ALTER TABLE "labos_threejs_core"."machines" ADD CONSTRAINT "machines_created_by_users_id_fk" FOREIGN KEY ("created_by") REFERENCES "labos_threejs_core"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "lab"."scene_installations" ADD CONSTRAINT "scene_installations_lab_id_labs_id_fk" FOREIGN KEY ("lab_id") REFERENCES "lab"."labs"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "lab"."scene_installations" ADD CONSTRAINT "scene_installations_created_by_users_id_fk" FOREIGN KEY ("created_by") REFERENCES "labos_threejs_core"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "lab"."publisher_leases" ADD CONSTRAINT "publisher_leases_session_id_simulation_sessions_id_fk" FOREIGN KEY ("session_id") REFERENCES "lab"."simulation_sessions"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "lab"."publisher_leases" ADD CONSTRAINT "publisher_leases_machine_id_machines_id_fk" FOREIGN KEY ("machine_id") REFERENCES "labos_threejs_core"."machines"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "lab"."session_assets" ADD CONSTRAINT "session_assets_session_id_simulation_sessions_id_fk" FOREIGN KEY ("session_id") REFERENCES "lab"."simulation_sessions"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "lab"."session_assets" ADD CONSTRAINT "session_assets_representation_id_asset_representations_id_fk" FOREIGN KEY ("representation_id") REFERENCES "lab"."asset_representations"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "lab"."session_assets" ADD CONSTRAINT "session_assets_file_id_files_id_fk" FOREIGN KEY ("file_id") REFERENCES "labos_threejs_core"."files"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "lab"."session_objects" ADD CONSTRAINT "session_objects_session_id_simulation_sessions_id_fk" FOREIGN KEY ("session_id") REFERENCES "lab"."simulation_sessions"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "lab"."session_objects" ADD CONSTRAINT "session_objects_node_id_scene_nodes_id_fk" FOREIGN KEY ("node_id") REFERENCES "lab"."scene_nodes"("id") ON DELETE no action ON UPDATE no action DEFERRABLE INITIALLY DEFERRED;--> statement-breakpoint
ALTER TABLE "lab"."session_objects" ADD CONSTRAINT "session_objects_entity_id_entities_id_fk" FOREIGN KEY ("entity_id") REFERENCES "lab"."entities"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "lab"."simulation_sessions" ADD CONSTRAINT "simulation_sessions_lab_id_labs_id_fk" FOREIGN KEY ("lab_id") REFERENCES "lab"."labs"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "lab"."simulation_sessions" ADD CONSTRAINT "simulation_sessions_installation_id_scene_installations_id_fk" FOREIGN KEY ("installation_id") REFERENCES "lab"."scene_installations"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "lab"."simulation_sessions" ADD CONSTRAINT "simulation_sessions_machine_id_machines_id_fk" FOREIGN KEY ("machine_id") REFERENCES "labos_threejs_core"."machines"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "lab"."simulation_sessions" ADD CONSTRAINT "simulation_sessions_started_by_users_id_fk" FOREIGN KEY ("started_by") REFERENCES "labos_threejs_core"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "one_active_publisher_lease" ON "lab"."publisher_leases" USING btree ("session_id") WHERE "lab"."publisher_leases"."ended_at" is null;--> statement-breakpoint
CREATE UNIQUE INDEX "one_active_simulation_session" ON "lab"."simulation_sessions" USING btree ("lab_id") WHERE "lab"."simulation_sessions"."ended_at" is null;
--> statement-breakpoint
INSERT INTO lab.publisher_epoch(singleton,value) VALUES(true,0);
--> statement-breakpoint
CREATE FUNCTION lab.immutable_session_snapshot() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN
  IF NEW.snapshot IS DISTINCT FROM OLD.snapshot OR NEW.id<>OLD.id OR NEW.lab_id<>OLD.lab_id OR NEW.installation_id<>OLD.installation_id OR NEW.machine_id<>OLD.machine_id THEN
    RAISE EXCEPTION 'Simulation Session snapshot and identity are immutable' USING ERRCODE='23514';
  END IF;
  RETURN NEW;
END $$;
--> statement-breakpoint
CREATE TRIGGER immutable_session_snapshot BEFORE UPDATE ON lab.simulation_sessions FOR EACH ROW EXECUTE FUNCTION lab.immutable_session_snapshot();
