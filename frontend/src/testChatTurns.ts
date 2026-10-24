/** My Agent -> Test conversation turns (Test chat polish pass). Plain
 * functions, so the case-context rules can be tested directly:
 *
 * - Selecting a synthetic case that is not already active adds a "new
 *   synthetic case" context event to the transcript -- the conversation
 *   before it is kept.
 * - A CASE question ("How would I handle this?") always carries the case it
 *   is about, stored on the turn itself and shown as a compact reference,
 *   so it never depends on visual proximity to a case card.
 * - A GENERAL practice question carries no case context.
 */

export type TestCaseLike = { id: string; title: string; facts: string[]; intended_domain: string }
export type CaseRef = { id: string; title: string; domain: string }

export const CASE_QUESTION = 'How would I handle this?'

export const caseRefOf = (testCase: TestCaseLike): CaseRef => ({ id: testCase.id, title: testCase.title, domain: testCase.intended_domain })

/** The context event for switching to `testCase`, or none when it is
 * already the active case (re-asking about the same case adds no divider). */
export function caseSwitchEvent(activeCaseId: string | null, testCase: TestCaseLike, id: string) {
  if (activeCaseId === testCase.id) return null
  return { id, role: 'case' as const, text: testCase.title, caseRef: caseRefOf(testCase), caseFacts: [...testCase.facts] }
}

/** What one turn sends: a case question is a synthetic-case request bound to
 * that case's id; anything else is a general practice question. */
export function turnRequest(text: string, caseContext: TestCaseLike | null) {
  return caseContext
    ? { mode: 'synthetic_case' as const, message: text, controlled_test_case_id: caseContext.id, origin: 'synthetic_demo' as const, caseRef: caseRefOf(caseContext) }
    : { mode: 'practice_question' as const, message: text, origin: 'practice' as const, caseRef: undefined }
}
