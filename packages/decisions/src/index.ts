// @mole/decisions: the decision graph behind the code (.mole tenets, decisions, intent, incidents + plain ADR folders)
// with citator-style flags computed by code (T29). Pure API: loadGraph(root, opts) -> computeFlags(graph, ctx).
export type * from './types.js';
export { frontMatter, loadGraph, MOLE_DIR, normStatus } from './graph.js';
export { formatSections, RATIONALE_BUDGET, sectionsOf, type DecisionSections } from './rationale.js';
export { computeFlags } from './flags.js';
export { contentHash } from './anchors.js';
export { decisions, decisionsCli, decisionCli, formatDecisions, incidentCli, prioritiesCli, recallCli } from './cli.js';
export { RECALL_NOTE, RecallError, recallSimilar } from './recall/recall.js';
export type { RecallCase, RecallOptions, RecallQuery, RecallResult } from './recall/recall.js';
export { applyRecordTransaction, CaptureError, ID_PATTERN, linkDecisions, newDecision, recoverTransactions, supersedeDecision } from './capture/records.js';
export type { CaptureResult, NewDecisionInput, TransactionEntry } from './capture/records.js';
export { suggestDuplicates } from './capture/dedupe.js';
export type { DuplicateRecord, DuplicateSuggestion } from './capture/dedupe.js';
// T80: contestable AI-drafted arguments captured from a decision's own MADR structure, with an exact
// source span + provenance, draft until a person approves (CLI only; MCP stays read-only per contract).
export { captureAdrArguments } from './capture/arguments.js';
export type { ArgumentProvenance, ArgumentRole, ArgumentStatus, CapturedArgument, TextQuoteSpan } from './capture/arguments.js';
export { allCapturedArguments, approveCapturedArgument, CapturedArgumentError, capturedDir, capturedPath, listCapturedArguments, rejectCapturedArgument, saveCapturedArguments } from './capture/captured-store.js';
export { argumentsCli } from './capture/arguments-cli.js';
export * from './check/index.js';
export * from './compile/index.js';
export * from './cascade/index.js';
export * from './route/index.js';
// T30: the annotated file tree (badges, colors, intent cards per folder)
export * from './tree/index.js';
export { CALL_RULES_FILE, checkRules, DEPCRUISE_FILE, depcruiseRuleSet, emitConfig, formatRules, loadRules, rulesCli } from './rules/index.js';
export type { RuleDecision, RuleKind, RuleSpec, RulesLoad, RulesOptions, RulesResult, SkippedRules, Violation } from './rules/index.js';
// T48: Argdown-sourced argument relations (supports/attacks/undercuts) + the packages/reasoning adapter
export { argumentFramework } from './argdown/framework.js';
export type { ArgumentFramework } from './argdown/framework.js';
export { parseArgdown } from './argdown/parser.js';
export type { ArgdownItem, ArgdownItemKind, ArgdownRelation, ArgdownRelationType, ParsedArgdown } from './argdown/parser.js';
export { loadArgdown } from './argdown/loader.js';
// T54: derive a Dung framework from an ADR's own MADR/Nygard sections (no hand-authored Argdown file)
export { deriveAdrArgumentFramework } from './argdown/derive-adr.js';
export type { AdrArgument, AdrArgumentFramework, AdrArgumentRole } from './argdown/derive-adr.js';
export { acceptIncident, dismissIncident, IncidentError, incidentArgumentId, incidentSummary, suggestRevivals } from './incidents/revive.js';
export type { IncidentWrite, PhaseSelector, RevivalCandidate, RevivalEvidence } from './incidents/revive.js';
export { comparePhases, compareWithOrder, evaluateOrder, evaluatePhase, phaseAt, phaseInForce, PrioritiesError, readPriorities, selectPhase, setPriorities, tenetValues, today } from './priorities.js';
export type { FlippedAttack, Phase, PhaseComparison, PhaseEvaluation } from './priorities.js';
export { argumentDefinitions } from './argdown/definitions.js';
export type { ArgumentDefinition } from './argdown/definitions.js';
// T72: `mole export --format okf` -- Open Knowledge Format v0.2 bundle of the decision graph
export { buildOkfBundle, OKF_VERSION } from './export/okf.js';
export type { OkfBundle, OkfFile } from './export/okf.js';
export { exportCli } from './export/cli.js';
// T78 (D65): per-link assurance on door: one-way decisions, never inferred -- see assurance/report.ts header.
export { assuranceCli, assuranceReport, isValidIsoDate, parseAssurance } from './assurance/report.js';
export type { AssuranceOptions } from './assurance/report.js';
// T81 (D66): outcome tracking log -- prediction/outcome/rollout front matter, due/overdue checks, never-automatic
// SUGGESTED incident drafts on a contradicted outcome (see outcomes/report.ts header).
export { outcomesCli, outcomesReport, parseOutcomeBlocks } from './outcomes/report.js';
export type { OutcomesOptions } from './outcomes/report.js';
export { draftIncidentRecord } from './incidents/revive.js';
