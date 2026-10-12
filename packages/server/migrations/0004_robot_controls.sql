CREATE TABLE "lab"."robot_source_events" (
	"recording_id" uuid NOT NULL,
	"event_id" uuid NOT NULL,
	"source_event_sequence" numeric(20, 0) NOT NULL,
	CONSTRAINT "robot_source_events_recording_id_event_id_pk" PRIMARY KEY("recording_id","event_id")
);
--> statement-breakpoint
CREATE TABLE "lab"."session_device_runs" (
	"session_id" uuid NOT NULL,
	"entity_id" uuid NOT NULL,
	"binding_id" uuid NOT NULL,
	"run_id" uuid NOT NULL,
	"recording_id" uuid NOT NULL,
	CONSTRAINT "session_device_runs_session_id_entity_id_pk" PRIMARY KEY("session_id","entity_id"),
	CONSTRAINT "session_device_runs_run_id_unique" UNIQUE("run_id")
);
--> statement-breakpoint
ALTER TABLE "lab"."robot_source_events" ADD CONSTRAINT "robot_source_events_recording_id_recordings_id_fk" FOREIGN KEY ("recording_id") REFERENCES "lab"."recordings"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "lab"."session_device_runs" ADD CONSTRAINT "session_device_runs_session_id_simulation_sessions_id_fk" FOREIGN KEY ("session_id") REFERENCES "lab"."simulation_sessions"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "lab"."session_device_runs" ADD CONSTRAINT "session_device_runs_entity_id_entities_id_fk" FOREIGN KEY ("entity_id") REFERENCES "lab"."entities"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "lab"."session_device_runs" ADD CONSTRAINT "session_device_runs_binding_id_runtime_bindings_id_fk" FOREIGN KEY ("binding_id") REFERENCES "lab"."runtime_bindings"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "lab"."session_device_runs" ADD CONSTRAINT "session_device_runs_run_id_program_runs_id_fk" FOREIGN KEY ("run_id") REFERENCES "lab"."program_runs"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "lab"."session_device_runs" ADD CONSTRAINT "session_device_runs_recording_id_recordings_id_fk" FOREIGN KEY ("recording_id") REFERENCES "lab"."recordings"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "robot_source_event_sequence" ON "lab"."robot_source_events" USING btree ("recording_id","source_event_sequence");