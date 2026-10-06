CREATE TABLE "labos_threejs_core"."file_references" (
	"file_id" uuid NOT NULL,
	"owner_type" text NOT NULL,
	"owner_id" text NOT NULL,
	"created_at" timestamp(6) with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "file_references_file_id_owner_type_owner_id_pk" PRIMARY KEY("file_id","owner_type","owner_id")
);
--> statement-breakpoint
ALTER TABLE "labos_threejs_core"."files" DROP CONSTRAINT "files_ready_key_unique";--> statement-breakpoint
ALTER TABLE "labos_threejs_core"."file_references" ADD CONSTRAINT "file_references_file_id_files_id_fk" FOREIGN KEY ("file_id") REFERENCES "labos_threejs_core"."files"("id") ON DELETE no action ON UPDATE no action;