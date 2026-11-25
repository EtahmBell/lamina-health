"""Pilot baseline on Postgres: every pilot table (and the identity/approval/rule tables the pilot
shares with onboarding), their indexes, and every append-only / immutability guarantee that SQLite
enforced with triggers, as PL/pgSQL triggers -- plus TRUNCATE guards SQLite never needed.

Revision ID: 0001_pilot_baseline
Revises: (none)
"""

from __future__ import annotations

from pathlib import Path

from alembic import op

revision = "0001_pilot_baseline"
down_revision = None
branch_labels = None
depends_on = None

# (table, message): no UPDATE, DELETE or TRUNCATE -- exactly the SQLite append-only tables.
APPEND_ONLY = (
    ("pilot_events", "pilot_events is append-only"),
    ("triage_recommendations", "triage recommendations are immutable"),
    ("recommendation_decisions", "recommendation decisions are immutable"),
    ("recommendation_carryovers", "carryovers are append-only"),
    ("public_profile_snapshots", "public snapshots are immutable"),
    ("triage_corrections", "triage corrections are append-only"),
    ("referral_signoffs", "referral sign-offs are append-only"),
    ("correction_conflict_resolutions", "conflict resolutions are append-only"),
    ("representation_versions", "representation versions are append-only"),
    ("capability_events", "capability events are append-only"),
    ("agent_prepared_items", "agent-prepared items are append-only"),
)

# Trigger names kept identical to the SQLite ones (one table used a shorter prefix there).
TRIGGER_PREFIX = {"public_profile_snapshots": "public_snapshots"}

TRIGGERS = r"""
CREATE FUNCTION lamina_forbid() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  RAISE EXCEPTION '%', TG_ARGV[0];
END $$;

-- Outbound messages: immutable once written (as in SQLite: no UPDATE).
CREATE TRIGGER outbound_messages_no_update BEFORE UPDATE ON outbound_messages
  FOR EACH ROW EXECUTE FUNCTION lamina_forbid('outbound messages are immutable');

-- Provider claims: the identity never changes; one active physician claim per account.
CREATE TRIGGER provider_claims_identity_immutable BEFORE UPDATE OF npi, auth_user_id ON provider_claims
  FOR EACH ROW WHEN (NEW.npi IS DISTINCT FROM OLD.npi OR NEW.auth_user_id IS DISTINCT FROM OLD.auth_user_id)
  EXECUTE FUNCTION lamina_forbid('provider claim identity is immutable');

CREATE FUNCTION lamina_one_active_claim() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF NEW.status IN ('claimed', 'verification_pending', 'verified')
     AND (TG_OP = 'INSERT' OR OLD.status NOT IN ('claimed', 'verification_pending', 'verified'))
     AND EXISTS (SELECT 1 FROM provider_claims WHERE auth_user_id = NEW.auth_user_id
                 AND id IS DISTINCT FROM NEW.id AND status IN ('claimed', 'verification_pending', 'verified')) THEN
    RAISE EXCEPTION 'account already holds an active physician claim';
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER provider_claims_one_active_per_account_insert BEFORE INSERT ON provider_claims
  FOR EACH ROW EXECUTE FUNCTION lamina_one_active_claim();
CREATE TRIGGER provider_claims_one_active_per_account_update BEFORE UPDATE OF status ON provider_claims
  FOR EACH ROW EXECUTE FUNCTION lamina_one_active_claim();

-- Owner scopes: must match their claim; start pending; identity immutable; approval needs a
-- confirmed, active identity.
CREATE FUNCTION lamina_owner_scope_insert() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM provider_claims WHERE id = NEW.provider_claim_id
                 AND npi = NEW.npi AND auth_user_id = NEW.auth_user_id) THEN
    RAISE EXCEPTION 'owner scope must match its provider claim';
  END IF;
  IF NEW.pilot_access_status <> 'pending' THEN
    RAISE EXCEPTION 'new owner scopes start pending pilot approval';
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER physician_owner_scopes_insert_checks BEFORE INSERT ON physician_owner_scopes
  FOR EACH ROW EXECUTE FUNCTION lamina_owner_scope_insert();
CREATE TRIGGER physician_owner_scopes_identity_immutable
  BEFORE UPDATE OF npi, auth_user_id, provider_claim_id, storage_scope_id, physician_id ON physician_owner_scopes
  FOR EACH ROW WHEN (NEW.npi IS DISTINCT FROM OLD.npi OR NEW.auth_user_id IS DISTINCT FROM OLD.auth_user_id
                     OR NEW.provider_claim_id IS DISTINCT FROM OLD.provider_claim_id
                     OR NEW.storage_scope_id IS DISTINCT FROM OLD.storage_scope_id
                     OR NEW.physician_id IS DISTINCT FROM OLD.physician_id)
  EXECUTE FUNCTION lamina_forbid('owner scope identity is immutable');
CREATE FUNCTION lamina_approval_requires_confirmation() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM provider_claims WHERE id = NEW.provider_claim_id
                 AND identity_confirmed_at IS NOT NULL AND status IN ('claimed', 'verification_pending', 'verified')) THEN
    RAISE EXCEPTION 'pilot approval requires a confirmed active identity';
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER physician_owner_scopes_approval_requires_confirmation
  BEFORE UPDATE OF pilot_access_status ON physician_owner_scopes
  FOR EACH ROW WHEN (NEW.pilot_access_status = 'approved')
  EXECUTE FUNCTION lamina_approval_requires_confirmation();

-- The rule store: legacy (non-practice) rows keep their derived columns in sync; a practice
-- rule's content is immutable -- edits create a new version.
CREATE FUNCTION lamina_referral_preferences_legacy_sync() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP = 'INSERT' THEN
    NEW.referral_type := COALESCE(NEW.referral_type, NEW.case_family);
  END IF;
  NEW.operational_status := CASE NEW.status WHEN 'draft' THEN 'inferred' ELSE NEW.status END;
  NEW.physician_confirmed := CASE WHEN NEW.confirmed_at IS NOT NULL THEN 1 ELSE 0 END;
  RETURN NEW;
END $$;
CREATE TRIGGER referral_preferences_legacy_sync_insert BEFORE INSERT ON physician_referral_preferences
  FOR EACH ROW WHEN (NEW.scope <> 'practice') EXECUTE FUNCTION lamina_referral_preferences_legacy_sync();
CREATE TRIGGER referral_preferences_legacy_sync_update BEFORE UPDATE OF status, confirmed_at ON physician_referral_preferences
  FOR EACH ROW WHEN (NEW.scope <> 'practice') EXECUTE FUNCTION lamina_referral_preferences_legacy_sync();
CREATE TRIGGER referral_preferences_practice_content_immutable
  BEFORE UPDATE OF structured_rules_json, source_text, referral_type, version, practice_id ON physician_referral_preferences
  FOR EACH ROW WHEN (OLD.scope = 'practice')
  EXECUTE FUNCTION lamina_forbid('practice rule content is immutable; create a new version');
"""


def upgrade() -> None:
    op.execute((Path(__file__).with_name("0001_pilot_tables.sql")).read_text(encoding="utf-8"))
    op.execute(TRIGGERS)
    for table, message in APPEND_ONLY:
        literal = message.replace("'", "''")
        name = TRIGGER_PREFIX.get(table, table)
        op.execute(f"CREATE TRIGGER {name}_no_update BEFORE UPDATE ON {table} FOR EACH ROW "
                   f"EXECUTE FUNCTION lamina_forbid('{literal}')")
        op.execute(f"CREATE TRIGGER {name}_no_delete BEFORE DELETE ON {table} FOR EACH ROW "
                   f"EXECUTE FUNCTION lamina_forbid('{literal}')")
        op.execute(f"CREATE TRIGGER {name}_no_truncate BEFORE TRUNCATE ON {table} FOR EACH STATEMENT "
                   f"EXECUTE FUNCTION lamina_forbid('{literal}')")


def downgrade() -> None:
    raise RuntimeError("The pilot baseline is not reversible (it holds the audit trail)")
