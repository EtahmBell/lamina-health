"""Agent-first Home: what needs you, what Lamina is waiting on, what it prepared,
and what happened while you were away — computed only from real pilot state."""

from __future__ import annotations

from datetime import UTC, datetime, timedelta
from typing import Any

from .intake import IntakeService
from .learning import LearningService
from .missing_info import MissingInformationService
from .models import TERMINAL_STATUSES
from .practice import PracticeContext
from .rules import PracticeRules
from .standing import queue_detail
from .store import PilotStore
from .voice import Voice

AWAY_DEFAULT = timedelta(hours=24)
AWAY_MAX = timedelta(days=7)
HOME_VIEW_DEDUPE = timedelta(minutes=10)
DONE_EVENTS = {
    "referral_accepted": "Accepted", "referral_redirected": "Redirected", "referral_declined": "Declined",
    "missing_information_resolved": "Missing information resolved",
    "sender_document_received": "Referring office uploaded a document",
    "sender_response_received": "Referring office replied",
    "referral_became_ready": "Became ready for review",
    # A physician confirming a rule is not something the agent "learned" on its own: say what happened.
    "learning_confirmed": "Rule confirmed", "learning_edited": "Rule confirmed (edited)",
    "missing_information_request_sent": "Information request sent",
}


def _join(parts: list[str]) -> str:
    if not parts:
        return ""
    sentence = parts[0] if len(parts) == 1 else ", ".join(parts[:-1]) + (", and " if len(parts) > 2 else " and ") + parts[-1]
    return sentence[:1].upper() + sentence[1:] + "."


def _plural(count: int, one: str, many: str) -> str:
    words = ["No", "One", "Two", "Three", "Four", "Five", "Six", "Seven", "Eight", "Nine", "Ten"]
    number = words[count] if count < len(words) else str(count)
    return f"{number} {one if count == 1 else many}"


class HomeService:
    def __init__(self, store: PilotStore, intake: IntakeService, missing: MissingInformationService,
                 rules: PracticeRules, learning: LearningService, representation: Any = None) -> None:
        self.store, self.intake, self.missing, self.rules, self.learning = store, intake, missing, rules, learning
        self.representation = representation
        self.activation: Any = None  # Step 18: readiness review / capability items

    def _since(self, context: PracticeContext, record_view: bool = True) -> str:
        views = [e for e in self.store.events(practice_id=context.practice_id, event_type="home_viewed", actor=context.actor)]
        now = datetime.now(UTC)
        last = datetime.fromisoformat(views[-1]["created_at"]) if views else now - AWAY_DEFAULT
        if record_view and (not views or now - last >= HOME_VIEW_DEDUPE):
            self.store.append_event("home_viewed", actor=context.actor, practice_id=context.practice_id)
        since = max(last, now - AWAY_MAX) if views else now - AWAY_DEFAULT
        # A just-refreshed page still shows the last day's activity.
        return min(since, now - timedelta(hours=1)).isoformat(timespec="seconds")

    def projection(self, context: PracticeContext, record_view: bool = True) -> dict:
        """record_view=False is the read-only variant (the agent's pending-work tool): it
        neither records a home view nor marks today's learning question as shown."""
        physician = context.role == "physician"
        since = self._since(context, record_view)
        needs, waiting, prepared, done = [], [], [], []
        summaries = {item["id"]: item for item in self.intake.list(context)}
        names = {rid: item["patient_name"] for rid, item in summaries.items()}

        voice = Voice.for_context(context, self.intake.physician_name(context.practice_id))
        doctor = voice.doctor
        # Who does the paperwork: staff when the practice has any; otherwise the physician does it all.
        staff_paperwork = any(member["role"] == "staff" for member in self.store.members(context.practice_id))
        paperwork_is_mine = not physician or not staff_paperwork
        closed = {status.value for status in TERMINAL_STATUSES}

        for item in summaries.values():
            path = f"/me/referrals/{item['id']}"
            base = {"referral_id": item["id"], "patient_name": item["patient_name"], "referral_type": item["referral_type"], "path": path}
            name = item["patient_name"]
            if item["status"] in closed:
                # Declined / redirected: someone tells the referring office (outside Lamina).
                if item["status"] in {"declined", "redirected"} and not item.get("office_notified") and paperwork_is_mine:
                    needs.append({**base, "kind": "notify_office", "rank": 4,
                                  "title": f"Tell the referring office about {name}’s {'decline' if item['status'] == 'declined' else 'redirect'}",
                                  "detail": f"{item['referral_type']} · not sent — Lamina doesn’t send this; a draft is ready to copy",
                                  "action": "Open"})
                continue
            standing = item.get("standing") or {}
            conflict = self._conflict_for(context, item) if physician else None
            if conflict:
                # A correction a newer rule disagrees with: the physician's decision, ranked first.
                # Ranked just ahead of other decisions: it changes what deciding means.
                needs.append({**base, "kind": "correction_conflict", "rank": 0 if item["priority"] == "urgent" else 0.5,
                              "title": conflict, "detail": f"{item['referral_type']} · choose which applies before you decide",
                              "action": "Resolve"})
                continue
            if item["status"] == "ready_for_review":
                detail = queue_detail(item["referral_type"], standing, voice, flagged=item["escalated"],
                                      marked_ready_by=item.get("handoff_by_name") if item.get("handoff") == "ready" else None)
                if physician:
                    needs.append({**base, "kind": "ready_for_review", "rank": 0 if item["priority"] == "urgent" else 1,
                                  "title": f"{name} is ready for your decision", "detail": detail, "action": "Review"})
                else:
                    waiting.append({**base, "kind": "waiting_physician", "title": f"{name} — waiting on {doctor}", "detail": detail})
            elif item["status"] in {"received", "triaged"} and not item["decided"]:
                uncertain = item["fit"] in {"unknown", "possible", "outside_scope"} or item["requires_physician"]
                # No separate triage approval: physicians decide (accept / redirect / decline);
                # staff check the paperwork and mark it ready or flag it for the physician.
                if not paperwork_is_mine:
                    waiting.append({**base, "kind": "waiting_staff",
                                    "title": f"{name} — with staff for checking",
                                    "detail": f"{item['referral_type']} · "
                                              + ("triaged · draft request ready for staff" if standing.get("has_draft")
                                                 else "triaged, not checked by staff yet")
                                              + (" · has a fit question for you" if uncertain else "") + " · you can still open and decide"})
                    continue
                if standing.get("has_draft") and not physician:
                    continue  # the drafted request is already listed (prepared): one item per referral
                if physician:
                    title = (f"{name} has a routing question" if item["fit"] == "outside_scope" else
                             f"I’m not sure about {name}’s referral" if uncertain else
                             f"{name}’s referral is triaged and waiting for your decision")
                else:
                    title = (f"Check {name}’s referral, then mark it ready or flag it for {doctor}"
                             if uncertain else f"Check {name}’s referral and mark it ready for {doctor}")
                needs.append({**base, "kind": "triage_uncertain" if uncertain and physician else "triage_review",
                              "rank": 0 if item["priority"] == "urgent" else (2 if uncertain else 3), "title": title,
                              "detail": f"{item['referral_type']} · from {item['sender_name']}"
                                        + (f" · fit needs {doctor}’s judgment" if uncertain and not physician else ""),
                              "action": "Review"})
        for request in self.missing.open_requests(context.practice_id):
            name = names.get(request["referral_id"], "A referral")
            path = f"/me/referrals/{request['referral_id']}"
            labels = ", ".join(item["label"] for item in request["items"])
            if request["status"] == "draft":
                prepared.append({"kind": "draft_request", "referral_id": request["referral_id"], "path": path,
                                 "title": f"Information request for {name}", "detail": f"Asks for {labels}. Needs your OK to send.",
                                 "action": "Review & send"})
            elif request["status"] in {"sent", "partially_resolved"}:
                days = max(0, (datetime.now(UTC) - datetime.fromisoformat(request["sent_at"])).days) if request["sent_at"] else 0
                waiting.append({"kind": "waiting_sender", "referral_id": request["referral_id"], "path": path,
                                "title": f"{name} — waiting on the referring office",
                                "detail": f"Asked for {labels} {('today' if days == 0 else f'{days} day' + ('' if days == 1 else 's') + ' ago')}"
                                          + (" · partial response received" if request["status"] == "partially_resolved" else "")})
        if paperwork_is_mine:
            needs.extend(self._document_confirmations(context, summaries))
        # A referral waiting on information that nobody has asked for yet must not vanish
        # between "needs you" and "waiting on others".
        requested = {request["referral_id"] for request in self.missing.open_requests(context.practice_id)}
        flagged = {item["referral_id"] for item in needs if item.get("referral_id")}
        for item in summaries.values():
            if not paperwork_is_mine:
                break
            if item["status"] == "needs_information" and item["id"] not in requested and item["id"] not in flagged:
                missing = ", ".join(item["missing_items"]) or "the missing information"
                needs.append({"kind": "request_missing", "rank": 3, "referral_id": item["id"], "patient_name": item["patient_name"],
                              "referral_type": item["referral_type"], "path": f"/me/referrals/{item['id']}",
                              "title": f"Ask for {item['patient_name']}’s missing information",
                              "detail": f"{item['referral_type']} · missing {missing} · nothing requested yet",
                              "action": "Prepare request"})
        if physician:
            owner, include_practice = self.learning.audience(context)
            question = self.learning.question_for_today(context.practice_id, mark_shown=record_view, actor="agent:learning",
                                                        owner_scope_id=owner, include_practice=include_practice)
            if question:
                needs.append({"kind": "learning_question", "rank": 4, "question_id": question["id"],
                              "proposal_id": question["proposal_id"], "title": question["question"],
                              "detail": "Based on your recent corrections", "path": "/me/agent", "action": "Answer"})
            # Pending learnings come from the ONE summary every learning count uses.
            summary = self.representation.learning_summary(context) if self.representation else None
            for proposal in (summary or {}).get("pending_learnings", []):
                if proposal["source"] == "explicit_instruction":
                    suggested_by = proposal.get("suggested_by_name")
                    needs.append({"kind": "proposed_learning", "rank": 5, "proposal_id": proposal["id"],
                                  "title": f"{suggested_by} suggested something for your agent" if suggested_by else "Confirm what I learned",
                                  "detail": f"“{proposal['source_text'][:120]}”",
                                  "path": "/me/agent?tab=teach", "action": "Review"})
            lifecycle = (summary or {}).get("lifecycle") or {}
            if lifecycle.get("state") == "initializing":
                stage = next((s for s in lifecycle["stages"] if s["id"] == lifecycle.get("next_stage")), None)
                needs.append({"kind": "setup", "rank": -1, "path": f"/me/setup?stage={lifecycle.get('next_stage') or 'review'}",
                              "title": "Finish setting up your agent",
                              "detail": (f"Next: {stage['label']} · about {lifecycle['minutes_remaining']} min left. "
                                         "Until then it can record referrals but doesn’t represent you yet.") if stage else
                                        "Review and confirm how your agent represents you.",
                              "action": "Continue setup"})

        for event in self.store.events(practice_id=context.practice_id):
            if event["created_at"] < since or event["event_type"] not in DONE_EVENTS:
                continue
            referral_id = event["referral_id"]
            label = DONE_EVENTS[event["event_type"]]
            title = f"{label}: {names.get(referral_id, 'a referral')}" if referral_id else (
                f"{label}: {event['metadata'].get('referral_type', 'a referral rule')}")
            if event["event_type"] in {"learning_confirmed", "learning_edited"} and event.get("actor"):
                title += f" · by {self._actor_name(context, event['actor'])}"
            done.append({"kind": event["event_type"], "title": title, "at": event["created_at"],
                         "by_agent": event["autonomy"] == "automatic",
                         "path": f"/me/referrals/{referral_id}" if referral_id else "/me/rules"})
        public_new = [e for e in self.store.events(practice_id=context.practice_id, event_type="referral_received")
                      if e["created_at"] >= since and e["metadata"].get("source") == "public_form"]
        for event in public_new:
            done.append({"kind": "public_referral", "title": f"New referral via your public page: {names.get(event['referral_id'], 'referral')}",
                         "at": event["created_at"], "by_agent": True, "path": f"/me/referrals/{event['referral_id']}"})
        if physician and self.activation is not None:
            needs.extend(self.activation.home_items(context))
        needs.sort(key=lambda item: item.get("rank", 9))
        done.sort(key=lambda item: item["at"], reverse=True)
        learned = [{"referral_type": rule.referral_type, "version": rule.version, "confirmed_at": rule.confirmed_at}
                   for rule in sorted(self.rules.list(context.practice_id), key=lambda r: r.confirmed_at or "", reverse=True)[:3]]
        return {"briefing": self._briefing(needs, waiting, prepared, done, physician), "needs_you": needs,
                "waiting": waiting, "prepared": prepared, "done": done[:12], "since": since, "learned": learned,
                "role": context.role}

    @staticmethod
    def _conflict_for(context: PracticeContext, item: dict) -> str | None:
        """The conflict this physician should see, worded for them: their own correction ("your
        correction"), or -- only when the rule is practice-wide -- another physician's ("Dr. X's
        correction"). Someone else's correction against their own rule isn't shown."""
        name = item["patient_name"]
        for conflict in item.get("conflicts") or []:
            mine = conflict["corrected_by"] == context.actor
            practice_wide = conflict["rule_layer"] == "practice"
            if not mine and not practice_wide:
                continue
            rule = (f"your newer {conflict['referral_type']} rule" if conflict["rule_by"] in {context.actor, None}
                    else f"the newer practice {conflict['referral_type']} rule")
            who = "your correction" if mine else f"{conflict['corrected_by_name'] or 'another physician'}’s correction"
            return f"{name}: {who} differs from {rule}"
        return None

    def _actor_name(self, context: PracticeContext, actor: str) -> str:
        from .attribution import ActorDirectory

        return ActorDirectory(self.store, context.practice_id).describe(actor)["name"]

    def _document_confirmations(self, context: PracticeContext, summaries: dict) -> list[dict]:
        items = []
        for referral_id, summary in summaries.items():
            if summary["status"] not in {"needs_information", "triaged", "ready_for_review"}:
                continue
            row = self.store.referral_row(context.practice_id, referral_id)
            recommendation = self.intake.recommendation(context.practice_id, row["current_recommendation_id"])
            proposed = [r.label for r in (recommendation.requirements if recommendation else []) if r.state == "proposed_from_document"]
            if proposed:
                items.append({"kind": "confirm_evidence", "rank": 3, "referral_id": referral_id,
                              "path": f"/me/referrals/{referral_id}",
                              "title": f"Confirm what {summary['patient_name']}’s documents show",
                              "detail": f"Possibly found: {', '.join(proposed)}", "action": "Confirm"})
            # The referring office replied with values: received, not yet verified. Staff and
            # physicians both see this -- verifying is intake work, not a physician decision.
            reported = [r.label for r in (recommendation.requirements if recommendation else []) if r.state == "sender_reported"]
            if reported:
                items.append({"kind": "verify_sender_information", "rank": 3, "referral_id": referral_id,
                              "path": f"/me/referrals/{referral_id}",
                              "title": f"Verify what the referring office sent for {summary['patient_name']}",
                              "detail": f"Received, not yet verified: {', '.join(reported)}", "action": "Verify"})
        return items

    @staticmethod
    def _briefing(needs: list, waiting: list, prepared: list, done: list, physician: bool) -> dict:
        """The lead count and the sentence describing it come from the SAME list: every item in
        "Needs you" is counted in exactly one phrase, so the phrases always add up to the lead."""
        counts: dict[str, int] = {}
        for item in needs:
            counts[item["kind"]] = counts.get(item["kind"], 0) + 1

        def take(*kinds: str) -> int:
            return sum(counts.pop(kind, 0) for kind in kinds)

        parts: list[str] = []
        if take("setup"):
            parts.append("your agent’s setup isn’t finished")
        if n := take("capability_returned"):
            parts.append(f"{_plural(n, 'capability was', 'capabilities were').lower()} returned to shadow after a serious flag")
        if n := take("capability_notice"):
            parts.append(f"{_plural(n, 'change was', 'changes were').lower()} made to what your agent may do")
        if n := take("correction_conflict"):
            parts.append(f"{_plural(n, 'referral has', 'referrals have').lower()} a correction that differs from your newer rule")
        if n := take("ready_for_review"):
            parts.append(f"{_plural(n, 'referral is', 'referrals are').lower()} ready for review")
        if n := take("triage_uncertain"):
            parts.append(f"{_plural(n, 'referral has', 'referrals have').lower()} a routing or fit question")
        if n := take("triage_review"):
            parts.append(f"{_plural(n, 'triaged referral is', 'triaged referrals are').lower()} waiting for your decision"
                         if physician else
                         f"{_plural(n, 'triaged referral needs', 'triaged referrals need').lower()} checking before the physician sees {'it' if n == 1 else 'them'}")
        if n := take("confirm_evidence"):
            parts.append(f"{_plural(n, 'referral needs', 'referrals need').lower()} document evidence confirmed")
        if n := take("request_missing"):
            parts.append(f"{_plural(n, 'referral is', 'referrals are').lower()} missing information nobody has asked for yet")
        if n := take("verify_sender_information"):
            parts.append(f"{_plural(n, 'referral has', 'referrals have').lower()} a reply from the referring office to verify")
        if n := take("notify_office"):
            parts.append(f"{_plural(n, 'referring office needs', 'referring offices need').lower()} telling about a decision")
        if n := take("learning_question", "proposed_learning"):
            parts.append("I noticed something I’d like you to confirm" if n == 1
                         else f"I noticed {_plural(n, 'thing', 'things').lower()} I’d like you to confirm")
        if n := take("readiness_review"):
            parts.append("your agent’s readiness review is available")
        if n := sum(counts.values()):  # anything new is still counted, never dropped
            parts.append(f"{_plural(n, 'other item', 'other items').lower()} below")
        if needs:
            lead = f"{_plural(len(needs), 'thing needs', 'things need')} you today."
            detail = _join(parts)
        else:
            lead, detail = "Nothing needs you right now.", ""
        tail = []
        if prepared:
            tail.append(f"I prepared {_plural(len(prepared), 'information request', 'information requests').lower()} for your approval.")
        if waiting:
            office = sum(1 for item in waiting if item["kind"] == "waiting_sender")
            if office:
                tail.append(f"I’m waiting on missing records for {_plural(office, 'referral', 'referrals').lower()}.")
            with_staff = sum(1 for item in waiting if item["kind"] == "waiting_staff")
            if with_staff:
                tail.append(f"{_plural(with_staff, 'triaged referral is', 'triaged referrals are')} with staff for checking.")
        away = len(done)
        return {"lead": lead, "detail": detail, "tail": " ".join(tail),
                "away": f"{_plural(away, 'update', 'updates')} since you were last here." if away else ""}

