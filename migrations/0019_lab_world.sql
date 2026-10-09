CREATE TABLE lab.labs (
    id uuid PRIMARY KEY,
    name text NOT NULL CHECK (length(btrim(name)) BETWEEN 1 AND 120),
    layout_version bigint NOT NULL DEFAULT 0,
    created_by uuid NOT NULL REFERENCES labos_threejs_core.users(id),
    created_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE lab.entities (
    id uuid PRIMARY KEY,
    lab_id uuid NOT NULL REFERENCES lab.labs(id),
    name text NOT NULL CHECK (length(btrim(name)) BETWEEN 1 AND 120),
    kind text NOT NULL,
    reality text NOT NULL CHECK (reality IN ('simulated', 'physical')),
    definition_id text NOT NULL,
    definition_version text NOT NULL,
    definition jsonb NOT NULL,
    configuration jsonb NOT NULL,
    representation_id uuid REFERENCES lab.asset_representations(id),
    created_by uuid NOT NULL REFERENCES labos_threejs_core.users(id),
    updated_by uuid NOT NULL REFERENCES labos_threejs_core.users(id),
    created_at timestamptz NOT NULL DEFAULT now(),
    updated_at timestamptz NOT NULL DEFAULT now(),
    UNIQUE (lab_id, id)
);
CREATE INDEX entities_lab_id ON lab.entities(lab_id, id);

CREATE TABLE lab.scene_nodes (
    id uuid PRIMARY KEY,
    lab_id uuid NOT NULL REFERENCES lab.labs(id),
    entity_id uuid NOT NULL,
    representation_id uuid REFERENCES lab.asset_representations(id),
    placement jsonb NOT NULL,
    FOREIGN KEY (lab_id, entity_id) REFERENCES lab.entities(lab_id, id)
);
CREATE INDEX scene_nodes_lab_id ON lab.scene_nodes(lab_id, id);
