"""The intake pipeline and basic patient identity (run 3).

Tables: `intake_items` (the staff Intake inbox), `intake_documents` (each received file, stored
through the storage interface, with its extracted pages), `practice_inbound_addresses` (a
practice's dedicated fax number / email address), `inbound_webhook_receipts` (one row per
vendor event: replay protection and "nothing silently dropped"), `patients` (a record per
practice) and `patient_merges` (every merge and unmerge, reversible). `intake_referrals` gains
`patient_id`.

Guarantees: `patient_merges` and `inbound_webhook_receipts` are append-only -- triggers (no
UPDATE/DELETE/TRUNCATE) and `lamina_app` privileges, as in 0001/0002.

Revision ID: 0003_intake_pipeline
Revises: 0002_append_only_privileges
"""

from __future__ import annotations

from pathlib import Path

from alembic import op

revision = "0003_intake_pipeline"
down_revision = "0002_append_only_privileges"
branch_labels = None
depends_on = None

APPEND_ONLY = (
    ("patient_merges", "patient merges are append-only"),
    ("inbound_webhook_receipts", "webhook receipts are append-only"),
)
NEW_TABLES = ("patients", "patient_merges", "practice_inbound_addresses", "intake_items", "intake_documents",
              "inbound_webhook_receipts")


def upgrade() -> None:
    op.execute((Path(__file__).with_name("0003_intake_pipeline.sql")).read_text(encoding="utf-8"))
    for table, message in APPEND_ONLY:
        literal = message.replace("'", "''")
        op.execute(f"CREATE TRIGGER {table}_no_update BEFORE UPDATE ON {table} FOR EACH ROW "
                   f"EXECUTE FUNCTION lamina_forbid('{literal}')")
        op.execute(f"CREATE TRIGGER {table}_no_delete BEFORE DELETE ON {table} FOR EACH ROW "
                   f"EXECUTE FUNCTION lamina_forbid('{literal}')")
        op.execute(f"CREATE TRIGGER {table}_no_truncate BEFORE TRUNCATE ON {table} FOR EACH STATEMENT "
                   f"EXECUTE FUNCTION lamina_forbid('{literal}')")
    for table in NEW_TABLES:
        op.execute(f"GRANT SELECT, INSERT, UPDATE, DELETE ON {table} TO lamina_app")
    op.execute("GRANT USAGE, SELECT ON ALL SEQUENCES IN SCHEMA public TO lamina_app")
    for table, _ in APPEND_ONLY:
        op.execute(f"REVOKE UPDATE, DELETE, TRUNCATE ON {table} FROM lamina_app")


def downgrade() -> None:
    op.execute("DROP INDEX IF EXISTS intake_referrals_patient")
    op.execute("ALTER TABLE intake_referrals DROP COLUMN IF EXISTS patient_id")
    for table in reversed(NEW_TABLES):
        op.execute(f"DROP TABLE IF EXISTS {table} CASCADE")
