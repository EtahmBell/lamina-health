# Lamina product and engineering rules

These instructions apply to all work in this repository.

## Product

- Lamina is not chatbot-first. `Consult Network` is the primary product primitive.
- The core flow is patient context → relevant physician agents → inspectable specialty-care recommendation.
- Do not add a social feed, physician posts, or public agent conversations.
- Keep V1 small and optimize for a strong synthetic end-to-end demonstration.
- Do not introduce time-series language models (TSLMs) unless explicitly requested.

## Clinical data and claims

- V1 uses synthetic data only. Never add real PHI.
- Clearly label synthetic patients, physicians, histories, availability, and network data.
- Physician-specific claims must be grounded in supplied practice-footprint data.
- Apply the evidence hierarchy: patient facts, explicit physician rules, historical-practice similarity, operational constraints, then bounded inference.
- Explicit physician rules override preferences inferred from historical cases.
- Historical case similarity is a fit signal, not proof of physician quality.
- Do not claim that more similar cases make a physician objectively better.
- Recommendations must be inspectable and show the facts, rules, practice signals, constraints, and conclusions used.
- Never expose hidden chain-of-thought. Store and show concise structured evidence only.
- LLMs may assist reasoning and orchestration but must not be the sole source of clinical truth.

## Clinical interoperability

- Keep NPPES provider identity separate from Medplum/FHIR patient context.
- Consultation code consumes only the bounded `ClinicalDataSource` interface; never pass raw FHIR resources or credentials to physician agents.
- The default clinical source must remain deterministic and offline. An explicitly configured Medplum source must fail visibly rather than silently falling back.
- Medplum demo resources must be tagged synthetic, use stable identifiers, and be upserted without deleting unrelated resources.
- Consultation messages are deliberate structured records, not hidden reasoning. Store only concise summaries, selected evidence, related patient facts, sequence, and bounded metadata.

## Engineering

- Keep domain logic separate from API and UI code.
- Prefer simple, interpretable implementations and avoid unnecessary dependencies.
- Core tests must be deterministic, run offline, and require no production credentials.
- Keep the fixture system easy to extend with a future second case.
- Keep FHIR/Medplum behind a bounded clinical-data interface; do not expose credentials or raw FHIR records to models.
- Do not commit `.env` files, credentials, local databases, generated artifacts, or sensitive data.
- The sibling `../lamina-og/` tree is read-only reference material. Never modify it.
