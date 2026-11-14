"""Deterministic, reviewable text normalization for pilot intake matching.

Used for two things only:

* comparing a submitted referral type with a practice's referral types (and their
  physician-controlled aliases), and
* matching a practice rule's fit / outside-scope / urgency phrases against referral text.

Everything here is explicit and inspectable: lowercasing, punctuation folding, simple
plural stripping, and a SHORT hand-maintained table of morphological variants of the same
word ("pregnant" / "pregnancy"). There is deliberately no stemming library, no edit
distance, and no semantic similarity: two different clinical concepts must never compare
equal here. Anything that does not match exactly after this normalization is treated as
"no match", and triage escalates it to a human instead of guessing.
"""

from __future__ import annotations

import re

# Variants of ONE word or spelling only -- never synonyms across concepts (e.g. "renal" is
# NOT mapped to "kidney"). Add entries only with a test, and only when both forms mean the
# same thing in referral text.
CONTROLLED_FORMS: dict[str, str] = {
    "pregnant": "pregnancy",
    "pregnancies": "pregnancy",
    "hyperthyroid": "hyperthyroidism",
    "hypothyroid": "hypothyroidism",
    "diabetes": "diabetes",  # guards the plural rule ("diabetes" is not a plural)
    "diabetic": "diabetes",
    "anaemia": "anemia",
    "anaemic": "anemia",
    "anemic": "anemia",
    "haematology": "hematology",
    "oedema": "edema",
    "paediatric": "pediatric",
    "graves": "graves",
    "lupus": "lupus",
    "pancreas": "pancreas",
    "pancreatitis": "pancreatitis",
}
# Words ending in "s" that are not plurals.
_NOT_PLURAL_ENDINGS = ("ss", "us", "is", "ous", "ics")


def canonical_word(word: str) -> str:
    """One lowercase token → its canonical form (controlled variant, else singular)."""
    word = word.casefold()
    if word in CONTROLLED_FORMS:
        return CONTROLLED_FORMS[word]
    if word.isdigit() or len(word) <= 3 or word.endswith(_NOT_PLURAL_ENDINGS):
        return word
    if word.endswith("ies") and len(word) > 4:
        return word[:-3] + "y"
    if word.endswith(("sses", "xes", "ches", "shes")):
        return word[:-2]
    if word.endswith("s"):
        return word[:-1]
    return word


def canonical_words(text: str) -> list[str]:
    return [canonical_word(word) for word in re.findall(r"[a-z0-9]+", text.casefold())]


# Words that never distinguish one referral type from another.
_TYPE_FILLER = {"referral", "referrals", "refer", "consult", "consultation", "eval", "evaluation",
                "for", "of", "the", "a", "an", "and", "to", "re", "new", "patient"}


def referral_type_key(value: str) -> str:
    """Canonical comparison key for a referral type: "Thyroid nodules referral" and
    "thyroid  nodule" share a key; "Thyroid nodule" and "Thyroid cancer" do not."""
    words = [word for word in canonical_words(value) if word not in _TYPE_FILLER]
    return " ".join(sorted(set(words)))


def type_key_words(value: str) -> set[str]:
    key = referral_type_key(value)
    return set(key.split()) if key else set()
