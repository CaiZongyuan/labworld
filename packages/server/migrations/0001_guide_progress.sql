CREATE TABLE "lab"."guide_progress" (
	"actor_id" uuid NOT NULL,
	"guide_id" text NOT NULL,
	"guide_version" text NOT NULL,
	"revision" bigint NOT NULL,
	"status" text NOT NULL,
	"step" text,
	"guide_attempt_id" uuid,
	"context" jsonb,
	"updated_at" timestamp(6) with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "guide_progress_actor_id_guide_id_guide_version_pk" PRIMARY KEY("actor_id","guide_id","guide_version"),
	CONSTRAINT "guide_revision" CHECK ("lab"."guide_progress"."revision" BETWEEN 1 AND 9007199254740991),
	CONSTRAINT "guide_status" CHECK ("lab"."guide_progress"."status" IN ('not_started','in_progress','paused','completed')),
	CONSTRAINT "guide_context" CHECK ("lab"."guide_progress"."context" IS NULL OR (jsonb_typeof("lab"."guide_progress"."context")='object' AND octet_length("lab"."guide_progress"."context"::text)<=4096))
);
--> statement-breakpoint
ALTER TABLE "lab"."guide_progress" ADD CONSTRAINT "guide_progress_actor_id_users_id_fk" FOREIGN KEY ("actor_id") REFERENCES "labos_threejs_core"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "guide_previous_progress" ON "lab"."guide_progress" USING btree ("actor_id","guide_id","updated_at" DESC NULLS LAST);