from backend.models import ClinicalRepresentation, HistoricalCase, PhysicianProfile


def similar_cases(
    context: ClinicalRepresentation, profile: PhysicianProfile
) -> list[tuple[HistoricalCase, list[str]]]:
    signals = set(context.signals)
    matches = []
    for case in profile.historical_cases:
        overlap = sorted(signals & set(case.features))
        if overlap:
            matches.append((case, overlap))
    return matches

