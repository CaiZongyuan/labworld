CREATE TABLE "lab"."asset_resource_uploads" (
	"upload_id" uuid PRIMARY KEY NOT NULL,
	"created_by" uuid NOT NULL
);
--> statement-breakpoint
CREATE TABLE "lab"."asset_version_resources" (
	"version_id" uuid NOT NULL,
	"key" text NOT NULL,
	"file_id" uuid NOT NULL,
	"format" text NOT NULL,
	"verification" text NOT NULL,
	"representation_id" uuid,
	"projected_asset_id" uuid,
	CONSTRAINT "asset_version_resource_key" UNIQUE("version_id","key")
);
--> statement-breakpoint
CREATE TABLE "lab"."asset_versions" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"asset_id" text NOT NULL,
	"namespace" text NOT NULL,
	"version" text NOT NULL,
	"content_sha256" text NOT NULL,
	"definition" jsonb NOT NULL,
	"representations" jsonb NOT NULL,
	"created_by" uuid NOT NULL,
	"created_at" timestamp(6) with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "asset_version_identity" UNIQUE("asset_id","version")
);
--> statement-breakpoint
ALTER TABLE "lab"."asset_resource_uploads" ADD CONSTRAINT "asset_resource_uploads_upload_id_files_id_fk" FOREIGN KEY ("upload_id") REFERENCES "labos_threejs_core"."files"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "lab"."asset_resource_uploads" ADD CONSTRAINT "asset_resource_uploads_created_by_users_id_fk" FOREIGN KEY ("created_by") REFERENCES "labos_threejs_core"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "lab"."asset_version_resources" ADD CONSTRAINT "asset_version_resources_version_id_asset_versions_id_fk" FOREIGN KEY ("version_id") REFERENCES "lab"."asset_versions"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "lab"."asset_version_resources" ADD CONSTRAINT "asset_version_resources_file_id_files_id_fk" FOREIGN KEY ("file_id") REFERENCES "labos_threejs_core"."files"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "lab"."asset_version_resources" ADD CONSTRAINT "asset_version_resources_representation_id_asset_representations_id_fk" FOREIGN KEY ("representation_id") REFERENCES "lab"."asset_representations"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "lab"."asset_version_resources" ADD CONSTRAINT "asset_version_resources_projected_asset_id_assets_id_fk" FOREIGN KEY ("projected_asset_id") REFERENCES "lab"."assets"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "lab"."asset_versions" ADD CONSTRAINT "asset_versions_created_by_users_id_fk" FOREIGN KEY ("created_by") REFERENCES "labos_threejs_core"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "asset_versions_namespace" ON "lab"."asset_versions" USING btree ("namespace","id");