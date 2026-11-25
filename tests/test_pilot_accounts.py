"""Accounts and access (go-live prep, run 1): invite-only practices, staff and physician
invitations, MFA enforcement, deactivation, session safety, recovery, and the dev-only test
sign-in used by the e2e harness. Synthetic data only."""

from __future__ import annotations

import json
import time
from datetime import UTC, datetime, timedelta
from pathlib import Path

import jwt
import pytest
from fastapi import HTTPException
from fastapi.testclient import TestClient

from backend.auth import AuthenticatedUser, AuthenticationError, SupabaseTokenVerifier
from backend.dev_test_auth import (
    DevTestCompositeVerifier,
    DevTestIdentityProvider,
    assert_dev_test_auth_allowed,
    install_dev_test_auth,
    refusal_reasons,
    totp,
)
from backend.main import create_app
from tests.test_pilot_foundation import NPI_A, NPI_B, Pilot, pilot  # noqa: F401
from tests.test_pilot_onboarding import _h


def _events(pilot: Pilot, **filters) -> list[str]:
    return [event["event_type"] for event in pilot.store.events(**filters)]


def _code(response) -> str:
    detail = response.json().get("detail")
    return detail.get("code") if isinstance(detail, dict) else ""


def _invite(pilot: Pilot, email: str, role: str = "staff", by: str = "user-a", label: str | None = None) -> dict:
    response = pilot.post("/api/me/practice/invitations", by, {"email": email, "role": role, "label": label})
    assert response.status_code == 201, response.text
    return response.json()


def _accept(pilot: Pilot, user: str, token: str):
    return pilot.post("/api/me/practice/invitations/accept", user, {"token": token})


# ------------------------------------------------------------------------ MFA


def test_every_pilot_route_needs_mfa_but_status_and_accepting_do_not(pilot: Pilot) -> None:
    pilot.ready_physician()
    for path in ("/api/me/practice/referrals", "/api/me/practice/home", "/api/me/practice/members"):
        refused = pilot.get(path, "user-a-aal1")
        assert refused.status_code == 403 and _code(refused) == "mfa_required", path
    # Onboarding and operator routes, in pilot mode, need MFA too.
    assert _code(pilot.post("/api/me/onboarding/npi/lookup", "user-b-aal1", {"npi": NPI_B})) == "mfa_required"
    assert _code(pilot.get("/api/internal/pilot-physicians", "admin-aal1")) == "mfa_required"
    assert _code(pilot.get("/api/internal/pilot-access/invitations", "admin-aal1")) == "mfa_required"
    status = pilot.status("user-a-aal1")
    assert status["next_step"] == "mfa" and status["practice"] is None, "nothing about the practice before MFA"
    assert status["account"] == {"email": "user-a@example.test", "mfa_verified": False}
    assert pilot.status("user-a")["next_step"] == "workspace"
    assert pilot.get("/api/me/practice/referrals", "user-a").status_code == 200
    # Audit: an account's first MFA-verified session is recorded once; an aal1-only account never.
    pilot.status("user-a")
    assert _events(pilot, actor="user:user-a").count("mfa_enrolled") == 1
    assert "mfa_enrolled" not in _events(pilot, actor="user:user-b")


def test_mfa_is_pilot_only_the_demo_is_unchanged() -> None:
    demo_paths = set(create_app("demo").openapi()["paths"])
    assert not any(path.startswith(("/api/internal/pilot-access", "/api/dev/")) for path in demo_paths)
    assert "/api/me/practice/sessions/revoke-all" not in demo_paths


# ------------------------------------------------------------- invite-only


def test_new_practices_need_an_operator_invitation_or_an_approved_request(pilot: Pilot) -> None:
    # An operator invites one physician (email + NPI). Non-operators can't.
    body = {"email": "user-d@example.test", "npi": NPI_B, "note": "Pilot cohort 1 (synthetic)"}
    assert pilot.post("/api/internal/pilot-access/invitations", "user-a", body).status_code == 404
    created = pilot.post("/api/internal/pilot-access/invitations", "admin", body)
    assert created.status_code == 201, created.text
    token = created.json()["token"]
    listed = pilot.get("/api/internal/pilot-access/invitations", "admin").json()
    assert listed[0]["state"] == "pending" and "token" not in listed[0]
    # Bound to the email: another account can't use the link.
    preview = pilot.post("/api/me/practice/invitations/preview", "user-e", {"token": token}).json()
    assert preview["kind"] == "new_practice" and preview["email_matches"] is False
    assert _code(_accept(pilot, "user-e", token)) == "invitation_email_mismatch"
    accepted = _accept(pilot, "user-d", token)
    assert accepted.status_code == 200 and accepted.json()["next_step"] == "physician_onboarding"
    # Confirming the invited NPI approves the request: practice setup opens, no manual review.
    pilot.confirm_physician("user-d", NPI_B)
    assert pilot.status("user-d")["next_step"] == "practice_setup"
    pilot.create_practice("user-d", "Doe Cardiology")
    assert pilot.status("user-d")["next_step"] == "workspace"
    assert "pilot_access_approved_by_invitation" in _events(pilot)
    assert pilot.get("/api/internal/pilot-access/invitations", "admin").json()[0]["state"] == "approved"
    # Without an invitation: a request waits for the operator; no practice until approved.
    pilot.confirm_physician("user-e", NPI_A)
    assert pilot.status("user-e")["next_step"] == "pilot_pending"
    assert _code(pilot.post("/api/me/practice", "user-e", {"name": "Self Serve Clinic"})) == "pilot_access_pending"


def test_an_operator_invitation_only_approves_the_npi_it_names(pilot: Pilot) -> None:
    token = pilot.post("/api/internal/pilot-access/invitations", "admin",
                       {"email": "user-d@example.test", "npi": NPI_A}).json()["token"]
    assert _accept(pilot, "user-d", token).status_code == 200
    pilot.confirm_physician("user-d", NPI_B)  # a different NPI
    assert pilot.status("user-d")["next_step"] == "pilot_pending", "falls back to manual review"
    # Revoked or expired operator invitations can't be used.
    other = pilot.post("/api/internal/pilot-access/invitations", "admin", {"email": "user-e@example.test", "npi": NPI_A}).json()
    assert pilot.client.delete(f"/api/internal/pilot-access/invitations/{other['id']}", headers=_h("admin")).status_code == 204
    assert _code(_accept(pilot, "user-e", other["token"])) == "invitation_unavailable"


# ------------------------------------------------------------ invitations


def test_staff_invitation_by_email_expires_can_be_revoked_and_is_single_use(pilot: Pilot) -> None:
    pilot.ready_physician()
    assert pilot.post("/api/me/practice/invitations", "user-a", {"role": "staff"}).status_code == 422, "an email is required"
    assert _code(pilot.post("/api/me/practice/invitations", "user-a", {"email": "not-an-email"})) == "invalid_email"
    invite = _invite(pilot, "User-C@Example.test", label="Front desk")
    assert invite["email"] == "user-c@example.test"
    assert datetime.fromisoformat(invite["expires_at"]) - datetime.now(UTC) <= timedelta(days=7, minutes=1)
    # The link is bound to the invited email.
    assert _code(_accept(pilot, "user-b", invite["token"])) == "invitation_email_mismatch"
    # Accepting works before MFA is set up (invite -> accept -> MFA -> first sign-in).
    joined = _accept(pilot, "user-c-aal1", invite["token"])
    assert joined.status_code == 200 and joined.json()["next_step"] == "mfa"
    assert pilot.status("user-c")["next_step"] == "workspace"
    assert _code(_accept(pilot, "user-c", invite["token"])) == "invitation_unavailable", "single use"
    # Revoked: unusable, recorded with who revoked it.
    revoked = _invite(pilot, "user-d@example.test")
    assert pilot.client.delete(f"/api/me/practice/invitations/{revoked['id']}", headers=_h("user-a")).status_code == 204
    assert _code(_accept(pilot, "user-d", revoked["token"])) == "invitation_unavailable"
    # Expired: unusable.
    expired = _invite(pilot, "user-e@example.test")
    past = (datetime.now(UTC) - timedelta(minutes=1)).isoformat(timespec="seconds")
    pilot.store.execute([("UPDATE practice_invitations SET expires_at = ? WHERE id = ?", (past, expired["id"]))])
    assert _code(_accept(pilot, "user-e", expired["token"])) == "invitation_unavailable"
    states = {row["id"]: row["state"] for row in pilot.get("/api/me/practice/members", "user-a").json()["invitations"]}
    assert states[revoked["id"]] == "revoked" and states[expired["id"]] == "expired" and states[invite["id"]] == "accepted"
    # Audit: every invitation, acceptance and revocation. Never the token, link or email.
    events = pilot.store.events()
    assert {"staff_invited", "staff_joined", "staff_invitation_revoked"} <= {e["event_type"] for e in events}
    stored = json.dumps(events)
    for secret in (invite["token"], revoked["token"], expired["token"], "user-c@example.test"):
        assert secret not in stored
    with pilot.store._connect() as db:
        assert invite["token"] not in json.dumps([list(row) for row in db.execute("SELECT * FROM practice_invitations").fetchall()])


def test_only_admins_invite_and_an_older_invitation_without_email_is_not_usable(pilot: Pilot) -> None:
    pilot.ready_physician()
    pilot.add_staff()
    assert _code(pilot.post("/api/me/practice/invitations", "user-c", {"email": "x@example.test"})) == "practice_admin_required"
    legacy = _invite(pilot, "user-d@example.test")
    pilot.store.execute([("UPDATE practice_invitations SET email = NULL WHERE id = ?", (legacy["id"],))])
    assert _code(_accept(pilot, "user-d", legacy["token"])) == "invitation_unavailable"


def test_second_physician_joins_by_invitation_with_their_own_identity_and_agent(pilot: Pilot) -> None:
    pilot.ready_physician()
    pilot.add_rule()  # the practice already has confirmed rules (written by the first physician)
    practice_id = pilot.store.membership_for_user("user-a")["practice_id"]
    invite = _invite(pilot, "user-b@example.test", role="physician")
    assert _accept(pilot, "user-b", invite["token"]).json()["next_step"] == "physician_onboarding"
    status = pilot.status("user-b")
    assert status["invitation"] == {"practice_name": "Smith Endocrinology", "role": "physician"}
    assert pilot.store.membership_for_user("user-b") is None, "no membership before their own NPI identity"
    pilot.confirm_physician("user-b", NPI_B)
    membership = pilot.store.membership_for_user("user-b")
    assert membership["practice_id"] == practice_id and membership["role"] == "physician"
    assert not membership["is_admin"], "non-admin by default"
    scope = pilot.workflow.selected_physician_owner_scope("user-b")
    assert membership["physician_owner_scope_id"] == scope["id"] != pilot.store.membership_for_user("user-a")["physician_owner_scope_id"]
    # The Lamina pilot gate still applies to a new physician identity.
    assert pilot.status("user-b")["next_step"] == "pilot_pending"
    pilot.approve("user-b")
    status = pilot.status("user-b")
    assert status["next_step"] == "workspace" and status["role"] == "physician" and status["is_admin"] is False
    # Their own agent: the representation and lifecycle are theirs (not the admin's).
    mine = pilot.get("/api/me/practice/representation", "user-b").json()
    assert mine["lifecycle"]["state"] == "initializing", "their own setup, even though the practice has rules"
    assert pilot.get("/api/me/practice/representation", "user-a").json()["lifecycle"]["state"] == "shadow"
    assert {"physician_invited", "physician_invitation_accepted", "physician_joined"} <= set(_events(pilot, practice_id=practice_id))
    # Non-admin: can't invite or deactivate.
    assert _code(pilot.post("/api/me/practice/invitations", "user-b", {"email": "x@example.test"})) == "practice_admin_required"


def test_a_staff_member_can_never_claim_a_physician_identity(pilot: Pilot) -> None:
    pilot.ready_physician()
    pilot.add_staff()
    for path, body in (("/api/me/onboarding/npi/lookup", {"npi": NPI_B}), ("/api/me/onboarding/identity/confirm", {"npi": NPI_B})):
        refused = pilot.post(path, "user-c", body)
        assert refused.status_code == 403 and _code(refused) == "staff_account", path
    # ... not via a physician invitation either, and not after being deactivated.
    invite = _invite(pilot, "user-c@example.test", role="physician")
    assert _code(_accept(pilot, "user-c", invite["token"])) in {"already_in_practice", "staff_account"}
    member = pilot.store.membership_for_user("user-c")["id"]
    assert pilot.post(f"/api/me/practice/members/{member}/deactivate", "user-a").status_code == 200
    assert _code(_accept(pilot, "user-c", invite["token"])) == "staff_account"
    assert _code(pilot.post("/api/me/onboarding/npi/lookup", "user-c", {"npi": NPI_B})) == "staff_account"
    # And a confirmed physician can't join as staff.
    pilot.confirm_physician("user-b", NPI_B)
    staff_invite = _invite(pilot, "user-b@example.test")
    assert _code(_accept(pilot, "user-b", staff_invite["token"])) == "physician_account"


# ------------------------------------------------------------- membership


def test_deactivation_ends_access_now_keeps_attribution_and_protects_the_last_admin(pilot: Pilot) -> None:
    pilot.ready_physician()
    pilot.add_staff()
    pilot.add_rule()
    rid = pilot.referral("user-c")["referral"]["id"]
    staff_member = pilot.store.membership_for_user("user-c")["id"]
    me = pilot.store.membership_for_user("user-a")["id"]
    assert _code(pilot.post(f"/api/me/practice/members/{me}/deactivate", "user-a")) == "cannot_deactivate_self"
    assert _code(pilot.post(f"/api/me/practice/members/{staff_member}/deactivate", "user-c")) == "practice_admin_required"
    view = pilot.post(f"/api/me/practice/members/{staff_member}/deactivate", "user-a")
    assert view.status_code == 200 and [m["role"] for m in view.json()["members"]] == ["physician"]
    # Access ends immediately, for every route.
    assert _code(pilot.get("/api/me/practice/referrals", "user-c")) == "practice_required"
    status = pilot.status("user-c")
    assert status["next_step"] == "access_ended" and status["access_ended"]["practice_name"] == "Smith Endocrinology"
    assert _code(pilot.get("/api/me/practice/referrals", "user-c-old")) == "session_revoked"
    # Their past work keeps their name.
    history = pilot.get(f"/api/me/practice/referrals/{rid}", "user-a").json()["history"]
    received = next(event for event in history if event["event_type"] == "referral_received")
    assert received["actor_name"] == "Front desk"
    event = next(e for e in pilot.store.events(event_type="member_deactivated"))
    assert event["actor"] == "user:user-a" and event["metadata"]["role"] == "staff"
    # The last admin can't step down or be removed.
    assert _code(pilot.client.put(f"/api/me/practice/members/{me}/admin", headers=_h("user-a"), json={"is_admin": False})) == "last_admin"
    assert pilot.get("/api/me/practice/members", "user-a").json()["members"][0]["can_deactivate"] is False


def test_deactivating_a_physician_and_admin_isolation_between_practices(pilot: Pilot) -> None:
    pilot.ready_physician()
    invite = _invite(pilot, "user-b@example.test", role="physician")
    _accept(pilot, "user-b", invite["token"])
    pilot.confirm_physician("user-b", NPI_B)
    pilot.approve("user-b")
    other = pilot.store.membership_for_user("user-b")["id"]
    pending = _invite(pilot, "user-e@example.test")
    # Grant user-b admin, then user-b (admin) deactivates user-a, the other admin: allowed.
    pilot.client.put(f"/api/me/practice/members/{other}/admin", headers=_h("user-a"), json={"is_admin": True})
    me = pilot.store.membership_for_user("user-a")["id"]
    assert pilot.post(f"/api/me/practice/members/{me}/deactivate", "user-b").status_code == 200
    assert pilot.status("user-a")["next_step"] == "access_ended"
    assert _code(pilot.post("/api/me/practice", "user-a", {"name": "Start Over"})) == "practice_creation_unavailable"
    # Someone outside the practice (here: the deactivated admin) can't revoke its invitations.
    refused = pilot.client.delete(f"/api/me/practice/invitations/{pending['id']}", headers=_h("user-a-old"))
    assert refused.status_code == 401 and _code(refused) == "session_revoked", "sessions from before are signed out"
    assert _code(pilot.client.delete(f"/api/me/practice/invitations/{pending['id']}", headers=_h("user-a"))) == "practice_required"
    assert _code(pilot.client.delete(f"/api/me/practice/invitations/{pending['id']}", headers=_h("user-d"))) == "practice_required"


# ------------------------------------------------------------ sessions


def test_sign_out_everywhere_refuses_every_earlier_session(pilot: Pilot) -> None:
    pilot.ready_physician()
    assert pilot.get("/api/me/practice/referrals", "user-a-old").status_code == 200
    revoked = pilot.post("/api/me/practice/sessions/revoke-all", "user-a")
    assert revoked.status_code == 200
    for path in ("/api/me/practice/referrals", "/api/me/practice/status"):
        refused = pilot.get(path, "user-a-old")
        assert refused.status_code == 401 and _code(refused) == "session_revoked", path
    assert pilot.get("/api/me/practice/referrals", "user-a").status_code == 200, "a new sign-in works"
    assert "signed_out_everywhere" in _events(pilot, actor="user:user-a")


# ------------------------------------------------------------ recovery


def test_lost_authenticator_recovery_is_member_initiated_and_operator_completed(pilot: Pilot) -> None:
    pilot.ready_physician()
    pilot.add_staff()
    # The member asks (signed in with their password only; no MFA yet).
    asked = pilot.post("/api/me/practice/mfa/recovery-request", "user-c-aal1", {"reason": "New phone (synthetic)"})
    assert asked.status_code == 200 and asked.json()["status"] == "open"
    assert pilot.status("user-c-aal1")["mfa_recovery"]["status"] == "open"
    queue = pilot.get("/api/internal/pilot-access/mfa-recovery", "admin").json()
    request_id = queue[0]["id"]
    # A practice admin has no way to complete (or start) a reset.
    assert pilot.post(f"/api/internal/pilot-access/mfa-recovery/{request_id}/complete", "user-a", {"note": "x"}).status_code == 404
    assert pilot.post(f"/api/internal/pilot-access/mfa-recovery/{request_id}/complete", "admin", {}).status_code == 422
    done = pilot.post(f"/api/internal/pilot-access/mfa-recovery/{request_id}/complete", "admin",
                      {"note": "Called the member back on the practice's listed number (synthetic)"})
    assert done.status_code == 200 and "Supabase" in done.json()["next"]
    # Every earlier session is signed out, and an earlier second factor no longer counts.
    assert _code(pilot.get("/api/me/practice/referrals", "user-c-old")) == "session_revoked"
    pilot.store.execute([("UPDATE pilot_account_security SET sessions_revoked_at = NULL WHERE user_id = 'user-c'", ())])
    assert _code(pilot.get("/api/me/practice/referrals", "user-c-old")) == "mfa_required"
    assert pilot.get("/api/me/practice/referrals", "user-c").status_code == 200, "after setting up MFA again"
    assert {"mfa_recovery_requested", "mfa_reset"} <= set(_events(pilot))
    assert "mfa_reenrolled" in _events(pilot, actor="user:user-c")


def test_an_operator_cannot_reset_their_own_mfa(pilot: Pilot) -> None:
    pilot.post("/api/me/practice/mfa/recovery-request", "admin-aal1", {})
    request_id = pilot.get("/api/internal/pilot-access/mfa-recovery", "admin").json()[0]["id"]
    refused = pilot.post(f"/api/internal/pilot-access/mfa-recovery/{request_id}/complete", "admin", {"note": "me"})
    assert refused.status_code == 403 and _code(refused) == "self_decision_forbidden"


# ------------------------------------------------------- dev-only test sign-in


E2E_ENV = {
    "LAMINA_E2E": "1", "LAMINA_E2E_TEST_AUTH": "1", "LAMINA_PRODUCT_MODE": "pilot", "LAMINA_DEV_FAKE_NPPES": "true",
    "LAMINA_DATABASE_URL": "postgresql://lamina:x@127.0.0.1:5433/lamina_e2e",
}


def test_dev_test_sign_in_is_refused_in_production_and_outside_the_e2e_harness() -> None:
    assert refusal_reasons(E2E_ENV) == []
    for override in ({"LAMINA_ENVIRONMENT": "production"}, {"RAILWAY_ENVIRONMENT": "production"}, {"VERCEL": "1"},
                     {"LAMINA_E2E": ""}, {"LAMINA_E2E_TEST_AUTH": "0"}, {"LAMINA_PRODUCT_MODE": "demo"},
                     {"LAMINA_DEV_FAKE_NPPES": "false"},
                     {"LAMINA_DATABASE_URL": "postgresql://lamina:x@127.0.0.1:5433/lamina_dev"},
                     {"LAMINA_DATABASE_URL": "postgresql://lamina:x@db.example.com:5432/lamina_e2e"},
                     {"LAMINA_PROFILE": "production"}):
        with pytest.raises(RuntimeError, match="refused"):
            assert_dev_test_auth_allowed({**E2E_ENV, **override})
        with pytest.raises(RuntimeError):
            install_dev_test_auth(create_app("pilot"), {**E2E_ENV, **override})
    # The real app never has it: no dev routes, and nothing in backend.main imports it.
    assert not [path for path in create_app("pilot").openapi()["paths"] if path.startswith("/api/dev/")]
    import backend.main as main_module

    assert "dev_test_auth" not in Path(main_module.__file__).read_text(encoding="utf-8")


def test_a_production_verifier_never_accepts_a_dev_test_token() -> None:
    provider = DevTestIdentityProvider()
    session = provider.sign_up("new.staff@example.test", "correct horse battery")
    verifier = SupabaseTokenVerifier(issuer="https://example.supabase.co/auth/v1", jwks_url="https://unused",
                                     audience="authenticated", jwks_loader=lambda: {"keys": []})
    with pytest.raises(AuthenticationError, match="unsupported signing key"):
        verifier.verify(session["access_token"])


def test_dev_test_sign_up_totp_and_the_gated_mfa_bypass() -> None:
    assert totp("GEZDGNBVGY3TQOJQGEZDGNBVGY3TQOJQ", at=59) == "287082"  # RFC 6238 test vector
    provider = DevTestIdentityProvider()
    session = provider.sign_up("new.staff@example.test", "correct horse battery")
    user = provider.verify(session["access_token"])
    assert (user.aal, user.email) == ("aal1", "new.staff@example.test")
    factor = provider.enroll(user)
    with pytest.raises(HTTPException, match="422"):
        provider.verify_factor(user, factor["factor_id"], "000000" if totp(factor["secret"]) != "000000" else "111111")
    upgraded = provider.verify(provider.verify_factor(user, factor["factor_id"], totp(factor["secret"]))["access_token"])
    assert upgraded.aal == "aal2" and provider.mfa_state(upgraded)["next"] == "aal2"
    with pytest.raises(HTTPException, match="400"):
        provider.sign_in("new.staff@example.test", "wrong password!!")

    class Primary:  # stands in for the real Supabase verifier
        def verify(self, token: str) -> AuthenticatedUser:
            sub = jwt.decode(token, options={"verify_signature": False})["sub"]
            return AuthenticatedUser(id=sub, aal="aal1", issued_at=int(time.time()))

    def supabase_like(sub: str) -> str:
        return jwt.encode({"sub": sub}, "k" * 32, headers={"kid": "supabase-key"})

    composite = DevTestCompositeVerifier(provider, Primary(), frozenset({"captured-staff"}))
    assert composite.verify(supabase_like("captured-staff")).aal == "aal2", "the gated bypass"
    assert composite.verify(supabase_like("someone-else")).aal == "aal1", "only the captured e2e accounts are exempt"
    assert composite.verify(session["access_token"]).id == user.id
    # End to end through the API with the gated install.
    app = create_app("pilot")
    install_dev_test_auth(app, {**E2E_ENV, "LAMINA_E2E_MFA_EXEMPT_USER_IDS": "captured-staff"})
    client = TestClient(app)
    signed = client.post("/api/dev/test-auth/sign-up", json={"email": "Invitee@Example.test", "password": "a long dev password"})
    assert signed.status_code == 200 and signed.json()["user"]["email"] == "invitee@example.test"
    bearer = {"Authorization": f"Bearer {signed.json()['access_token']}"}
    assert client.post("/api/dev/test-auth/mfa/state", headers=bearer).json()["next"] == "aal1"
    assert client.get("/api/me/practice/status", headers=bearer).json()["next_step"] == "mfa"
    enrolled = client.post("/api/dev/test-auth/mfa/enroll", headers=bearer).json()
    verified = client.post("/api/dev/test-auth/mfa/verify", headers=bearer,
                           json={"factor_id": enrolled["factor_id"], "code": totp(enrolled["secret"])})
    assert verified.status_code == 200, verified.text
    after = {"Authorization": f"Bearer {verified.json()['access_token']}"}
    assert client.get("/api/me/practice/status", headers=after).json()["account"]["mfa_verified"] is True
    assert client.post("/api/dev/test-auth/mfa/state", headers={"Authorization": "Bearer nope"}).status_code == 401


def test_idle_timeout_is_a_per_practice_admin_setting_and_audited(pilot: Pilot) -> None:
    pilot.ready_physician()
    pilot.add_staff()
    assert pilot.status("user-c")["practice"]["idle_timeout_minutes"] == 30, "the default"
    path = "/api/me/practice/security-settings"
    assert _code(pilot.client.put(path, headers=_h("user-c"), json={"idle_timeout_minutes": 45})) == "practice_admin_required"
    for out_of_range in (14, 61):
        refused = pilot.client.put(path, headers=_h("user-a"), json={"idle_timeout_minutes": out_of_range})
        assert refused.status_code == 422 and _code(refused) == "invalid_idle_timeout"
    changed = pilot.client.put(path, headers=_h("user-a"), json={"idle_timeout_minutes": 45})
    assert changed.status_code == 200 and changed.json()["idle_timeout_minutes"] == 45
    assert pilot.status("user-c")["practice"]["idle_timeout_minutes"] == 45, "applies to everyone in the practice"
    event = pilot.store.events(event_type="practice_idle_timeout_changed")[0]
    assert event["actor"] == "user:user-a" and event["metadata"] == {"from": 30, "to": 45}
