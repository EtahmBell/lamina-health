"""Real, authenticated specialist-practice pilot.

Everything in this package is deliberately separate from the synthetic demo:
it never imports demo personas, demo patients, synthetic fixtures, or the
anonymous demo workspace. Pilot data is keyed by a practice id that only an
authenticated, approved practice member can resolve (see ``access.py``).
"""
