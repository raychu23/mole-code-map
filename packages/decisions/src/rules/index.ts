// Decisions as rules (T27): a decision record's front matter `rules:` compiled to dependency-cruiser `forbidden` rules
// (imports) and Mole's own TS-compiler call scan (calls); every violation cites its decision, why and record file:line.
export type * from './types.js';
export { CALL_RULES_FILE, DEPCRUISE_FILE } from './types.js';
export { loadRules } from './parse.js';
export { depcruiseRuleSet } from './compile.js';
export { checkRules } from './check.js';
export { emitConfig, formatRules, rulesCli } from './cli.js';
