"""Who a sentence is addressed to.

A physician reads about their own agent and rules in the second person ("your rule"); staff read
the same facts about the physician ("Dr. Avery Testwell's rule"). Text is chosen per role from
structured values -- never produced by rewriting a stored second-person sentence.
"""

from __future__ import annotations

from dataclasses import dataclass

from .practice import PracticeContext


@dataclass(frozen=True)
class Voice:
    physician: bool
    doctor: str  # the physician's display name, or "the physician" when unknown

    @classmethod
    def for_context(cls, context: PracticeContext, physician_name: str | None) -> Voice:
        return cls(physician=context.role == "physician", doctor=physician_name or "the physician")

    @property
    def whose(self) -> str:
        """"your" / "Dr. X’s"."""
        return "your" if self.physician else f"{self.doctor}’s"

    @property
    def whose_cap(self) -> str:
        """Sentence-initial form of `whose`: "Your" / "Dr. X’s"."""
        return "Your" if self.physician else f"{self.doctor}’s"

    @property
    def subject(self) -> str:
        """"You" / "Dr. X" (sentence subject)."""
        return "You" if self.physician else self.doctor

    def verb(self, second: str, third: str) -> str:
        """The verb agreeing with `subject`: verb("see", "sees")."""
        return second if self.physician else third

    @property
    def object(self) -> str:
        """"you" / "Dr. X" (sentence object)."""
        return "you" if self.physician else self.doctor


PHYSICIAN = Voice(physician=True, doctor="the physician")
