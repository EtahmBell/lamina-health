/**
 * Physician-agent evaluation harness -- developer/demo UI (pre-NLP
 * foundational pass, Part S/T). A restrained internal surface reached
 * from Settings & demo, never a new top-level product navigation item,
 * never patient-facing, never a physician score.
 */

import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { test } from 'node:test'

const app = readFileSync(new URL('../src/App.tsx', import.meta.url), 'utf8')
const api = readFileSync(new URL('../src/api.ts', import.meta.url), 'utf8')

const slice = (source, from, to) => source.slice(source.indexOf(from), source.indexOf(to))

test('the evaluations surface is reached from Settings & demo, never a new top-level nav item', () => {
  assert.match(app, /if \(path === '\/settings\/agent-evaluations'\) return <AgentEvaluationsPage navigate=\{navigate\} \/>/)
  const settingsFn = slice(app, 'function SettingsPage', 'function UnfinishedPatient')
  assert.match(settingsFn, /onClick=\{\(\) => navigate\('\/settings\/agent-evaluations'\)\}>Physician agent evaluations →<\/button>/)
  const navItemsBlock = slice(app, 'const navItems = [', ']')
  assert.doesNotMatch(navItemsBlock, /agent-evaluations/, 'never added to the primary navItems list')
})

test('the page lists physicians, case counts, and the representation snapshot -- never a numeric physician score', () => {
  const pageFn = slice(app, 'function AgentEvaluationsPage', 'function SettingsPage')
  assert.match(pageFn, /getEvalPhysicians\(\)/)
  assert.match(pageFn, /Representation: \{result\?\.representation_snapshot_id \?\? physician\.representation_snapshot_id\}/)
  assert.doesNotMatch(pageFn, /[Aa]gent [Ss]core|performance score/i)
})

test('"Run evaluations" triggers the real suite run, populating per-case pass/fail -- never randomly rotating', () => {
  const pageFn = slice(app, 'function AgentEvaluationsPage', 'function SettingsPage')
  assert.match(pageFn, /const result = await runEvalSuite\(physicianId\)/)
  assert.match(pageFn, /const matchingRun = result\?\.runs\.find\(\(item\) => item\.eval_case_id === evalCase\.id\)/)
})

test('clicking a run case opens a detail modal with Expected/Actual/Assertions/Grounding, never raw hidden-reasoning dump', () => {
  const modalFn = slice(app, 'function EvalCaseDetailModal', 'function AgentEvaluationsPage')
  assert.match(modalFn, /<p className="section-label">Expected<\/p>/)
  assert.match(modalFn, /<p className="section-label">Actual<\/p>/)
  assert.match(modalFn, /<p className="section-label">Assertions<\/p>/)
  assert.match(modalFn, /Grounded in: \{assertion\.evidence\.join\('; '\)\}/)
  assert.doesNotMatch(modalFn, /chain.of.thought|reasoning_trace|scratchpad/i)
})

test('metrics shown are interpretable dimensions (pass rate, grounding, abstention), never one aggregate score', () => {
  const pageFn = slice(app, 'function AgentEvaluationsPage', 'function SettingsPage')
  assert.match(pageFn, /Pass rate \{Math\.round\(result\.metrics\.overall_assertion_pass_rate \* 100\)\}%/)
  assert.match(pageFn, /Grounding \{Math\.round\(result\.metrics\.grounding_correctness \* 100\)\}%/)
  assert.match(pageFn, /Correct abstention \{Math\.round\(result\.metrics\.correct_abstention \* 100\)\}%/)
})

test('the API client calls the real read-only/zero-side-effect endpoints -- list physicians, list cases, run suite', () => {
  assert.match(api, /export const getEvalPhysicians = \(\) => request<EvalPhysicianSummary\[\]>\('\/api\/workspace\/eval\/physicians'\)/)
  assert.match(api, /export const getEvalCases = \(physicianId: string\) => request<PhysicianAgentEvalCase\[\]>\(`\/api\/workspace\/eval\/physicians\/\$\{encodeURIComponent\(physicianId\)\}\/cases`\)/)
  assert.match(api, /export const runEvalSuite = \(physicianId: string\) => request<PhysicianAgentEvalSuiteResult>\(`\/api\/workspace\/eval\/physicians\/\$\{encodeURIComponent\(physicianId\)\}\/run`, \{ method: 'POST' \}\)/)
})

/* =====================================================================
 * Evaluation visibility pass, Part B-G: representation/system vs
 * agent-behavior evaluation, execution mode, repeated runs.
 * ===================================================================== */

test('cases are grouped into Representation/system and Agent behavior sections, never blended into one undifferentiated list', () => {
  const pageFn = slice(app, 'function AgentEvaluationsPage', 'function SettingsPage')
  assert.match(pageFn, /const representationCases = physicianCases\.filter\(\(item\) => item\.eval_category === 'representation_system'\)/)
  assert.match(pageFn, /const agentBehaviorCases = physicianCases\.filter\(\(item\) => item\.eval_category === 'agent_behavior'\)/)
  assert.match(pageFn, /Representation \/ system evaluation/)
  assert.match(pageFn, /Agent behavior evaluation \(model-dependent\)/)
})

test('execution mode is always shown explicitly -- a deterministic fallback is never rendered as a model pass', () => {
  assert.match(app, /function ExecutionModeBadge\(/)
  assert.match(app, /run\.execution_mode === 'model'/)
  assert.match(app, /<span className="eval-execution-mode model">Model: \{run\.model_id\}<\/span>/)
  assert.match(app, /<span className="eval-execution-mode deterministic">Deterministic fallback<\/span>/)
})

test('the detail modal surfaces the representation snapshot and execution mode alongside Expected/Actual', () => {
  const modalFn = slice(app, 'function EvalCaseDetailModal', 'function AgentEvaluationsPage')
  assert.match(modalFn, /<ExecutionModeBadge run=\{run\} \/>/)
  assert.match(modalFn, /Representation: \{run\.representation_snapshot_id\}/)
})

test('a model-dependent case offers restrained repeated-run inspection -- "N / M structural assertions passed", never a fabricated Agent Score', () => {
  const control = slice(app, 'function RepeatedRunControl', 'function AgentEvaluationsPage')
  assert.match(control, />Run once</)
  assert.match(control, />Run 5 times</)
  assert.match(control, /\{passed\} \/ \{runs\.length\} structural assertions passed/)
  assert.doesNotMatch(control, /[Aa]gent [Ss]core/)
})

test('the repeated-run API client is scoped to one case, never the whole suite', () => {
  assert.match(api, /export const runEvalCaseRepeated = \(physicianId: string, caseId: string, times: number\) => request<PhysicianAgentEvalRun\[\]>\(`\/api\/workspace\/eval\/physicians\/\$\{encodeURIComponent\(physicianId\)\}\/cases\/\$\{encodeURIComponent\(caseId\)\}\/run\?times=\$\{times\}`, \{ method: 'POST' \}\)/)
})
