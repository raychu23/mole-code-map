// Compile-at-capture (T46): a model drafts machine checks for a decision; a person approves or rejects; approved
// drafts merge into the decision record's own `scope:`/`match:`/`rules:` (T27/T32), so checking stays zero-LLM.
export type * from './types.js';
export { compilePrompt, draftChecksFor, parseDraftResponse, type DraftInput } from './draft.js';
export { hermesLlmClient, type HermesLlmOptions } from './llm.js';
export { allDrafts, approveDraft, compiledDir, compiledPath, getVersion, listVersions, rejectDraft, saveDraft, type ApproveOptions, type RejectOptions } from './store.js';
export { compileCli } from './cli.js';
