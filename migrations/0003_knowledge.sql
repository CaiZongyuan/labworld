CREATE SCHEMA knowledge;

CREATE TABLE knowledge.knowledge_bases (
    id uuid PRIMARY KEY,
    name text NOT NULL,
    personal_owner uuid UNIQUE REFERENCES labos_threejs_core.users(id),
    created_by uuid NOT NULL REFERENCES labos_threejs_core.users(id),
    created_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE knowledge.grants (
    knowledge_base_id uuid NOT NULL REFERENCES knowledge.knowledge_bases(id),
    user_id uuid NOT NULL REFERENCES labos_threejs_core.users(id),
    access text NOT NULL CHECK (access IN ('reader', 'editor')),
    PRIMARY KEY (knowledge_base_id, user_id)
);
CREATE INDEX knowledge_grants_user ON knowledge.grants(user_id, knowledge_base_id);

CREATE TABLE knowledge.documents (
    id uuid PRIMARY KEY,
    knowledge_base_id uuid NOT NULL REFERENCES knowledge.knowledge_bases(id),
    title text NOT NULL CHECK (length(btrim(title)) > 0),
    markdown text NOT NULL,
    version bigint NOT NULL DEFAULT 1 CHECK (version > 0),
    created_by uuid NOT NULL REFERENCES labos_threejs_core.users(id),
    updated_by uuid NOT NULL REFERENCES labos_threejs_core.users(id),
    created_at timestamptz NOT NULL DEFAULT now(),
    updated_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX documents_base_created ON knowledge.documents(knowledge_base_id, created_at DESC, id);
