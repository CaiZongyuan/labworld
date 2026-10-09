-- Compact receipts survive full Command retention. Existing Commands get a receipt atomically when cleanup removes them.
CREATE TABLE lab.command_receipts (
    actor_id uuid NOT NULL REFERENCES labos_threejs_core.users(id),
    entity_id uuid NOT NULL REFERENCES lab.entities(id),
    request_key text NOT NULL,
    command_id uuid NOT NULL UNIQUE,
    fingerprint text NOT NULL CHECK (length(fingerprint)=64),
    PRIMARY KEY(actor_id,entity_id,request_key)
);
