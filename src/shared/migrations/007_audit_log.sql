-- 007_audit_log.sql
-- Append-only audit trail for every state change in the SidelineIQ system.
-- Used by:
--   • Tier 1 pipeline (ingestion, fact validation, agent draft, publish, correction)
--   • Tier 2 control plane (draft edits, attestation, publish gate, retraction)
-- Immutability is enforced by an UPDATE/DELETE blocking trigger because the
-- service runs as a single Neon role; revoking permissions on the table would
-- require a separate role we do not have.

CREATE TABLE IF NOT EXISTS audit_log (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  ts TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT NOW(),
  actor VARCHAR(32) NOT NULL CHECK (actor IN ('system', 'md', 'automation', 'agent')),
  actor_id VARCHAR(255),
  entity_type VARCHAR(64) NOT NULL,
  entity_id UUID,
  action VARCHAR(64) NOT NULL,
  before_hash VARCHAR(64),
  after_hash VARCHAR(64),
  payload JSONB
);

CREATE INDEX IF NOT EXISTS idx_audit_log_entity ON audit_log(entity_type, entity_id, ts DESC);
CREATE INDEX IF NOT EXISTS idx_audit_log_actor ON audit_log(actor, ts DESC);
CREATE INDEX IF NOT EXISTS idx_audit_log_action ON audit_log(action, ts DESC);

CREATE OR REPLACE FUNCTION audit_log_immutable() RETURNS TRIGGER AS $$
BEGIN
  RAISE EXCEPTION 'audit_log is append-only; % is not permitted', TG_OP;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS audit_log_no_update ON audit_log;
CREATE TRIGGER audit_log_no_update
  BEFORE UPDATE ON audit_log
  FOR EACH ROW EXECUTE FUNCTION audit_log_immutable();

DROP TRIGGER IF EXISTS audit_log_no_delete ON audit_log;
CREATE TRIGGER audit_log_no_delete
  BEFORE DELETE ON audit_log
  FOR EACH ROW EXECUTE FUNCTION audit_log_immutable();
