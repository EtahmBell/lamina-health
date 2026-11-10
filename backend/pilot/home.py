"""Agent-first Home: what needs you, what Lamina is waiting on, what it prepared,
and what happened while you were away — computed only from real pilot state."""

from __future__ import annotations

from datetime import UTC, datetime, timedelta

from .intake import IntakeService
from .learning import LearningService
from .missing_info import MissingInformationService
from .models import TERMINAL_STATUSES
from .practice import PracticeContext
from .rules import PracticeRules
from .store import PilotStore

AWAY_DEFAULT = timedelta(hours=24)
AWAY_MAX = timedelta(days=7)
HOME_VIEW_DEDUPE = timedelta(minutes=10)
DONE_EVENTS = {
    "referral_accepted": "Accepted", "referral_redirected": "Redirected", "referral_declined": "Declined",
    "missing_information_resolved": "Missing information resolved",
    "sender_document_received": "Referring office uploaded a document",
    "sender_response_received": "Referring office replied",
    "referral_became_ready": "Became ready for review",
    "learning_confirmed": "Learned", "learning_edited": "Learned",
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
                 rules: PracticeRules, learning: LearningService) -> None:
        self.store, self.intake, self.missing, self.rules, self.learning = store, intake, missing, rules, learning

    def _since(self, context: PracticeContext) -> str:
        views = [e for e in self.store.events(practice_id=context.practice_id, event_type="home_viewed", actor=context.actor)]
        now = datetime.now(UTC)
        last = datetime.fromisoformat(views[-1]["created_at"]) if views else now - AWAY_DEFAULT
        if not views or now - last >= HOME_VIEW_DEDUPE:
            self.store.append_event("home_viewed", actor=context.actor, practice_id=context.practice_id)
        since = max(last, now - AWAY_MAX) if views else now - AWAY_DEFAULT
        # A just-refreshed page still shows the last day's activity.
        return min(since, now - timedelta(hours=1)).isoformat(timespec="seconds")

    def projection(self, context: PracticeContext) -> dict:
        physician = context.role == "physician"
        since = self._since(context)
        needs, waiting, prepared, done = [], [], [], []
        summaries = {item["id"]: item for item in self.intake.list(context)}
        names = {rid: item["patient_name"] for rid, item in summaries.items()}

        for item in summaries.values():
            if item["status"] in {status.value for status in TERMINAL_STATUSES}:
                continue
            path = f"/me/referrals/{item['id']}"
            base = {"referral_id": item["id"], "patient_name": item["patient_name"], "referral_type": item["referral_type"], "path": path}
            if item["status"] == "ready_for_review":
                if physician:
                    needs.append({**base, "kind": "ready_for_review", "rank": 0 if item["priority"] == "urgent" else 1,
                                  "title": f"{item['patient_name']} is ready for your decision",
                                  "detail": f"{item['referral_type']} · " + ("flagged for your review" if item["escalated"] else "complete per your rules"),
                                  "action": "Review"})
                else:
                    waiting.append({**base, "kind": "waiting_physician", "title": f"{item['patient_name']} — waiting on the physician",
                                    "detail": f"{item['referral_type']} · ready for review"})
            elif item["status"] in {"received", "triaged"} and not item["decided"]:
                uncertain = item["fit"] in {"unknown", "possible", "outside_scope"} or item["requires_physician"]
                needs.append({**base, "kind": "triage_uncertain" if uncertain else "triage_review",
                              "rank": 0 if item["priority"] == "urgent" else (2 if uncertain else 3),
                              "title": (f"{item['patient_name']} has a routing question" if item["fit"] == "outside_scope" else
                                        f"I’m not sure about {item['patient_name']}’s referral" if uncertain else
                                        f"{item['patient_name']}’s triage is ready to approve"),
                              "detail": f"{item['referral_type']} · from {item['sender_name']}", "action": "Review"})
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
        needs.extend(self._document_confirmations(context, summaries))
        if physician:
            question = self.learning.question_for_today(context.practice_id, mark_shown=True, actor="agent:learning")
            if question:
                needs.append({"kind": "learning_question", "rank": 4, "question_id": question["id"],
                              "proposal_id": question["proposal_id"], "title": question["question"],
                              "detail": "Based on your recent corrections", "path": "/me/agent", "action": "Answer"})
            for proposal in self.rules.proposals(context.practice_id):
                if proposal.source == "explicit_instruction":
                    needs.append({"kind": "proposed_learning", "rank": 5, "proposal_id": proposal.id,
                                  "title": "Confirm what I learned", "detail": f"“{(proposal.provenance or {}).get('raw_text', proposal.source_text)[:120]}”",
                                  "path": "/me/agent", "action": "Review"})

        for event in self.store.events(practice_id=context.practice_id):
            if event["created_at"] < since or event["event_type"] not in DONE_EVENTS:
                continue
            referral_id = event["referral_id"]
            label = DONE_EVENTS[event["event_type"]]
            title = f"{label}: {names.get(referral_id, 'a referral')}" if referral_id else (
                f"{label}: {event['metadata'].get('referral_type', 'a referral rule')}")
            done.append({"kind": event["event_type"], "title": title, "at": event["created_at"],
                         "by_agent": event["autonomy"] == "automatic",
                         "path": f"/me/referrals/{referral_id}" if referral_id else "/me/rules"})
        public_new = [e for e in self.store.events(practice_id=context.practice_id, event_type="referral_received")
                      if e["created_at"] >= since and e["metadata"].get("source") == "public_form"]
        for event in public_new:
            done.append({"kind": "public_referral", "title": f"New referral via your public page: {names.get(event['referral_id'], 'referral')}",
                         "at": event["created_at"], "by_agent": True, "path": f"/me/referrals/{event['referral_id']}"})
        needs.sort(key=lambda item: item.get("rank", 9))
        done.sort(key=lambda item: item["at"], reverse=True)
        learned = [{"referral_type": rule.referral_type, "version": rule.version, "confirmed_at": rule.confirmed_at}
                   for rule in sorted(self.rules.list(context.practice_id), key=lambda r: r.confirmed_at or "", reverse=True)[:3]]
        return {"briefing": self._briefing(needs, waiting, prepared, done, physician), "needs_you": needs,
                "waiting": waiting, "prepared": prepared, "done": done[:12], "since": since, "learned": learned,
                "role": context.role}

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
        return items

    @staticmethod
    def _briefing(needs: list, waiting: list, prepared: list, done: list, physician: bool) -> dict:
        kinds = [item["kind"] for item in needs]
        parts = []
        ready = kinds.count("ready_for_review")
        if ready:
            parts.append(f"{_plural(ready, 'referral is', 'referrals are').lower()} ready for review")
        routing = kinds.count("triage_uncertain")
        if routing:
            parts.append(f"{_plural(routing, 'referral has', 'referrals have').lower()} a routing or fit question")
        review = kinds.count("triage_review")
        if review:
            parts.append(f"{_plural(review, 'triage is', 'triages are').lower()} ready to approve")
        evidence = kinds.count("confirm_evidence")
        if evidence:
            parts.append(f"{_plural(evidence, 'referral needs', 'referrals need').lower()} document evidence confirmed")
        if "learning_question" in kinds or "proposed_learning" in kinds:
            parts.append("I noticed something I’d like you to confirm")
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
        away = len(done)
        return {"lead": lead, "detail": detail, "tail": " ".join(tail),
                "away": f"{_plural(away, 'update', 'updates')} since you were last here." if away else ""}

