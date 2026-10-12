from backend.models import ClinicalRepresentation, HistoricalCase


def similar_cases(
    context: ClinicalRepresentation, historical_cases: list[HistoricalCase]
) -> list[tuple[HistoricalCase, list[str]]]:
    signals = set(context.signals)
    matches = []
    for case in historical_cases:
        overlap = sorted(signals & set(case.features))
        if overlap:
            matches.append((case, overlap))
    return matches

