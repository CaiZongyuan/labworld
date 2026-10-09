CREATE TABLE lab.entity_relationships (
    id uuid PRIMARY KEY,
    lab_id uuid NOT NULL REFERENCES lab.labs(id),
    source_id uuid NOT NULL,
    target_id uuid NOT NULL,
    kind text NOT NULL CHECK (kind IN ('located_in', 'contains', 'simulates')),
    source text NOT NULL DEFAULT 'manual' CHECK (source = 'manual'),
    registered_by uuid NOT NULL REFERENCES labos_threejs_core.users(id),
    registered_at timestamptz NOT NULL DEFAULT now(),
    FOREIGN KEY (lab_id, source_id) REFERENCES lab.entities(lab_id, id),
    FOREIGN KEY (lab_id, target_id) REFERENCES lab.entities(lab_id, id),
    CHECK (source_id <> target_id),
    UNIQUE (lab_id, source_id, target_id, kind)
);
CREATE INDEX entity_relationships_lab_id ON lab.entity_relationships(lab_id, id);
