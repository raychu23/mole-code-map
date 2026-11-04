// `mole demo`: a self-contained, no-network, 0-model-call walkthrough. It writes a tiny sample repo with 3
// team decisions (as real `.mole/decisions/*.md` records with `rules:`, T27), shows `mole rules` passing clean,
// then makes an edit that breaks one decision's rule and shows the same check catching it -- the identical
// check plugins/claude-code's Stop hook runs on every session (plugins/claude-code/scripts/stop.mjs calls
// `ruleViolationsText`, which wraps this same checkRules()). Plain-words narration at every step; nothing here
// talks to a model, a daemon or the network. Lazy-imported from cli.ts (`mole demo`) so it never adds weight
// to any other command's startup.
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { checkRules, formatRules } from '@mole/decisions';

function write(root: string, rel: string, text: string): void {
  const p = join(root, rel);
  mkdirSync(join(p, '..'), { recursive: true });
  writeFileSync(p, text);
}

const DECISIONS: Array<{ file: string; text: string }> = [
  {
    file: '.mole/decisions/D001-no-legacy-billing.md',
    text: `---
id: D001
title: Payments never imports the legacy billing client directly
status: accepted
rules:
  - forbid: import
    from: src/payments/
    to: src/legacy-billing/
    why: legacy-billing has no refund path; payments must go through src/billing/
---

## Decision

\`src/payments/\` talks to \`src/billing/\` only. \`src/legacy-billing/\` is being retired and has no refund
support -- a payments file that imports it directly ships a refund bug by construction.
`,
  },
  {
    file: '.mole/decisions/D002-ui-no-db.md',
    text: `---
id: D002
title: UI code never reaches into the database layer directly
status: accepted
rules:
  - forbid: import
    from: src/ui/
    to: src/db/
    why: every DB read must go through src/billing/ so row-level auth checks run
---

## Decision

\`src/ui/\` never imports \`src/db/\`. All reads go through \`src/billing/\`, which applies the row-level
auth check every UI query needs.
`,
  },
  {
    file: '.mole/decisions/D003-no-eval.md',
    text: `---
id: D003
title: No dynamic eval anywhere in src/
status: accepted
rules:
  - forbid: call
    from: src/
    callee: eval
    why: a past incident shipped an injection bug through a templated eval() call
---

## Decision

Nothing in \`src/\` calls \`eval\`. (Past incident: a templated \`eval()\` call shipped an injection bug.)
`,
  },
  // sample source tree: compliant with all 3 decisions until the "break one" step edits checkout.ts
  { file: 'src/billing/client.ts', text: `export function charge(cents: number): string {\n  return \`charged \${cents}\`;\n}\n` },
  { file: 'src/legacy-billing/client.ts', text: `export function chargeOld(cents: number): string {\n  return \`legacy-charged \${cents}\`;\n}\n` },
  { file: 'src/payments/checkout.ts', text: `import { charge } from '../billing/client.js';\n\nexport function checkout(cents: number): string {\n  return charge(cents);\n}\n` },
  { file: 'src/db/orders.ts', text: `export function loadOrder(id: string): { id: string } {\n  return { id };\n}\n` },
  { file: 'src/ui/order-panel.ts', text: `import { charge } from '../billing/client.js';\n\nexport function renderCharge(cents: number): string {\n  return charge(cents);\n}\n` },
];

const BREAKING_EDIT = `import { charge } from '../billing/client.js';\nimport { chargeOld } from '../legacy-billing/client.js';\n\nexport function checkout(cents: number): string {\n  // "just this once, the legacy path refunds faster" -- exactly the shortcut D001 exists to block\n  return chargeOld(cents);\n}\n`;

function say(line: string): void {
  console.log(line);
}

export async function demoCli(): Promise<number> {
  const dir = mkdtempSync(join(tmpdir(), 'mole-demo-'));
  try {
    say('mole demo -- a 30-second walkthrough, no network, no model calls, nothing leaves this machine.\n');
    say(`1. Writing a tiny sample repo with 3 real team decisions into a temp dir:\n   ${dir}`);
    for (const d of DECISIONS) write(dir, d.file, d.text);
    say('   D001  Payments never imports the legacy billing client directly');
    say('   D002  UI code never reaches into the database layer directly');
    say('   D003  No dynamic eval anywhere in src/');
    say('   Each decision is a plain markdown file with a `rules:` block Mole can check deterministically --');
    say('   no model call, just an import/call-graph scan (dependency-cruiser + the TypeScript compiler API).\n');

    say('2. Checking the repo as it stands (`mole rules`):');
    const before = await checkRules(dir);
    say(formatRules(before).split('\n').map((l) => `   ${l}`).join('\n'));
    say(`   ${before.violations.length === 0 ? 'Clean: nothing in the sample code breaks a decision yet.' : 'Unexpected: the sample should start clean.'}\n`);

    say('3. Now simulate an agent (or a teammate) making a change that breaks D001:');
    say('   src/payments/checkout.ts switches from src/billing/ to the forbidden src/legacy-billing/ path.');
    write(dir, 'src/payments/checkout.ts', BREAKING_EDIT);
    say('   (this is the same kind of edit an agent makes mid-task when it is not shown the decision, or shown');
    say('   it and ignores it -- both happen in practice)\n');

    say('4. Checking again -- this is the exact check plugins/claude-code runs in its Stop hook on every session:');
    const after = await checkRules(dir);
    say(formatRules(after).split('\n').map((l) => `   ${l}`).join('\n'));
    if (after.violations.length > 0) {
      const v = after.violations[0]!;
      say(`\n   Caught: ${v.file}:${v.line} breaks ${v.decision.id} "${v.decision.title}".`);
      say(`   Why this decision exists: ${v.decision.why ?? '(no why recorded)'}`);
      say('   In Claude Code, this text is what the agent sees before it reports the task done -- it does not');
      say('   block the agent, it puts the decision and the reason back in front of a person before merge.');
    } else {
      say('\n   Unexpected: this edit was built to break D001 and did not get flagged. Please file this as a bug.');
    }
    say('\nThat is the whole loop: write a decision once in plain language, keep it in a file next to the code,');
    say('and every check from here on is free (no tokens, no model) until the code actually moves away from it.');
    say(`\nThe sample repo is left on disk so you can poke at it yourself (delete it whenever):\n  cd ${dir} && npx -y mole-code rules`);
    return after.violations.length > 0 ? 0 : 1;
  } catch (e) {
    rmSync(dir, { recursive: true, force: true });
    throw e;
  }
}
