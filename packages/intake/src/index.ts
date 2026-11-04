// @mole/intake: T23 agents interrogate, people write (D38). Public API: checkAllRecords/checkRecord (M30a,
// person-written records) and interrogate (code changes governed by decisions). Pure read: never writes a record.
export type * from './types.js';
export { checkAllRecords, checkRecord, loadDecisionGraph, QUESTION_TEMPLATES } from './record-check.js';
export { gatherEvidence, governingDecisions } from './evidence.js';
export { interrogate } from './interrogate.js';
export { intakeCli, formatFindings, formatInterrogate } from './cli.js';
