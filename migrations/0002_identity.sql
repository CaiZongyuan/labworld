CREATE TABLE labos_threejs_core.users (
    id uuid PRIMARY KEY,
    email text NOT NULL,
    normalized_email text NOT NULL UNIQUE,
    display_name text,
    created_at timestamptz NOT NULL DEFAULT now()
);
CREATE TABLE labos_threejs_core.credentials (
    user_id uuid PRIMARY KEY REFERENCES labos_threejs_core.users(id),
    password_hash text NOT NULL
);
CREATE TABLE labos_threejs_core.organizations (
    id integer PRIMARY KEY CHECK (id = 1),
    name text NOT NULL,
    owner_initialized boolean NOT NULL DEFAULT false
);
CREATE TABLE labos_threejs_core.memberships (
    user_id uuid PRIMARY KEY REFERENCES labos_threejs_core.users(id),
    organization_id integer NOT NULL REFERENCES labos_threejs_core.organizations(id),
    role text NOT NULL CHECK (role IN ('owner', 'admin', 'member')),
    active boolean NOT NULL DEFAULT true
);
CREATE TABLE labos_threejs_core.audit_events (
    id uuid PRIMARY KEY,
    actor_id uuid REFERENCES labos_threejs_core.users(id),
    action text NOT NULL,
    resource_id text NOT NULL,
    request_id text NOT NULL,
    created_at timestamptz NOT NULL DEFAULT now()
);
CREATE TABLE labos_threejs_core.sessions (
    id uuid PRIMARY KEY,
    secret_hash bytea NOT NULL UNIQUE,
    user_id uuid NOT NULL REFERENCES labos_threejs_core.users(id),
    expires_at timestamptz NOT NULL,
    last_seen_at timestamptz NOT NULL DEFAULT now(),
    revoked boolean NOT NULL DEFAULT false
);
CREATE INDEX sessions_user_id ON labos_threejs_core.sessions(user_id);
