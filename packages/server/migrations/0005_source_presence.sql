ALTER TABLE labos_threejs_core.machines ADD COLUMN credential_scope text NOT NULL DEFAULT 'publisher';
--> statement-breakpoint
CREATE TABLE lab.sources (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  lab_id uuid NOT NULL CONSTRAINT sources_lab_id_labs_id_fk REFERENCES lab.labs(id),
  name text NOT NULL,
  machine_id uuid CONSTRAINT sources_machine_id_machines_id_fk REFERENCES labos_threejs_core.machines(id),
  source_run_id uuid,
  connection_id uuid,
  epoch numeric(20,0) NOT NULL DEFAULT 0,
  phase text,
  last_seen_at timestamp(6) with time zone,
  created_by uuid NOT NULL CONSTRAINT sources_created_by_users_id_fk REFERENCES labos_threejs_core.users(id),
  created_at timestamp(6) with time zone NOT NULL DEFAULT now(),
  CONSTRAINT source_name CHECK (length(btrim(name)) BETWEEN 1 AND 120),
  CONSTRAINT source_epoch CHECK (epoch BETWEEN 0 AND 18446744073709551615),
  CONSTRAINT source_phase CHECK (phase IN ('initializing','ready'))
);
--> statement-breakpoint
CREATE INDEX sources_lab ON lab.sources(lab_id,id);
