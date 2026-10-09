ALTER TABLE knowledge.knowledge_bases ADD COLUMN deleted_at timestamptz;
ALTER TABLE knowledge.knowledge_bases ADD COLUMN cleanup_job_id uuid REFERENCES labos_threejs_core.jobs(id);
ALTER TABLE knowledge.documents ADD COLUMN deleted_at timestamptz;
ALTER TABLE knowledge.documents ADD COLUMN cleanup_job_id uuid REFERENCES labos_threejs_core.jobs(id);
CREATE INDEX knowledge_bases_active ON knowledge.knowledge_bases(id) WHERE deleted_at IS NULL;
DROP INDEX knowledge.documents_base_created;
CREATE INDEX documents_base_created ON knowledge.documents(knowledge_base_id, created_at DESC, id) WHERE deleted_at IS NULL;
