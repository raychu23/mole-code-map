// T48: a small subset of Argdown's own grammar (christianvoigt/argdown, MIT), covering only the
// top-level titled statement/argument relation graph the decision graph needs -- NOT Argdown's full
// grammar (premise-conclusion reconstruction `--`/`----` inference blocks, ranges, tags, YAML head,
// `><` contradiction/entailment-derivation, CLI, HTML/dot/map export). That full grammar is exactly
// what `@argdown/core` (MIT, used as a devDependency only -- see package.json) already implements;
// re-implementing it here is this task's own non-goal. The relation *symbols* and their *direction*
// are copied exactly from argdown-core's lexer.ts (matchIncomingSupport/.../matchOutgoingUndercut)
// and cross-checked against argdown-core's own ModelPlugin unit test ("can create statement
// relations and ignore duplicates") and a from-scratch undercut fixture, both run through the real
// @argdown/core parser and saved as oracle JSON in fixtures/argdown/*.oracle.json
// (test/argdown-parser.test.ts asserts this parser's output matches those oracles exactly).
//
// Symbol -> direction, from argdown-core/src/lexer.ts's matchers (bare `+`/`-` default to the
// "outgoing" reading per `/^([' '\t]*)(<?\+)/` and `/^([' '\t]*)(<?-)/`):
//   +>  incoming support   parent --supports--> child   (ModelPlugin.ts INCOMING_SUPPORT: from=parent)
//   ->  incoming attack     parent --attacks-->  child   (INCOMING_ATTACK: from=parent)
//   _>  incoming undercut   parent --undercuts--> child  (INCOMING_UNDERCUT: from=parent)
//   <+ or +   outgoing support   child --supports--> parent   (OUTGOING_SUPPORT: to=parent)
//   <- or -   outgoing attack    child --attacks-->  parent   (OUTGOING_ATTACK: to=parent)
//   <_        outgoing undercut  child --undercuts--> parent  (OUTGOING_UNDERCUT: to=parent)
// `><` (contradiction) and bare statement-to-statement ENTAILS/CONTRARY derivations are a logical
// relation, not a dialectical one (model.ts:46-53) -- out of scope for an EdgeType that only has
// supports/attacks/undercuts; lines using `><` emit no relation but ARE reported as an unsupported
// token in `problems` (T48 fix), so a `><` edge is never silently dropped on the floor.
//
// NOTE (undercut semantics, T48 header note): this parser has no premise-conclusion-structure
// (PCS) / inference model, so an undercut relation here can only ever target a conclusion
// statement/argument node -- i.e. it collapses to "attack the conclusion". That is a simplification:
// in Pollock's original sense (and ASPIC+'s formalization), an undercutter targets the *inference*
// from premises to conclusion, not the conclusion itself -- it defeats the warrant without claiming
// the conclusion is false. If/when this package grows PCS support (named premises, `--`/`----`
// inference lines, inference rules), undercut edges must be re-pointed at the inference step, not
// the conclusion node, or the attack/undercut distinction this EdgeType exists to preserve is lost.
//
// This parser also does not implement PCS (premise-conclusion-structure) / inference blocks
// (`(1) premise`, `----`, inference rules) at all: such lines are ignored for graph-building
// purposes (same as always), but are now reported once per parse via `problems` (T48 fix) so a
// `.argdown` file that actually uses PCS doesn't silently lose that content with no signal.

export type ArgdownItemKind = 'statement' | 'argument';
export type ArgdownRelationType = 'supports' | 'attacks' | 'undercuts';

/** One thing this parser's subset grammar couldn't represent; same shape as the graph's Problem minus `file` (the loader adds that). */
export interface ArgdownProblem {
  line: number;
  message: string;
}

export interface ArgdownItem {
  /** Argdown keys its statement/argument dictionaries by title; Mole's graph id is that same title. */
  id: string;
  kind: ArgdownItemKind;
  title: string;
  /** 1-based line of the first occurrence (definition or reference) seen. */
  line: number;
  /** every `<title>: text` definition (top-level or inline after a relation arrow), in order: where the item's own
   *  text and #tags live (T60 review 2: `line` above can be an earlier bare reference) */
  definitions: Array<{ line: number; text: string }>;
}

export interface ArgdownRelation {
  from: string;
  to: string;
  type: ArgdownRelationType;
  line: number;
}

export interface ParsedArgdown {
  items: ArgdownItem[];
  relations: ArgdownRelation[];
  /** Syntax this parser's subset can't represent: blank-line-broken relation blocks, `><` and
   * other unrecognized relation tokens, and PCS/inference lines. Same semantics as graph.ts's
   * Problem (loader.ts pushes these into the graph's problems[] with `file` attached). */
  problems: ArgdownProblem[];
}

const REL_TOKENS: Array<{ tok: string; dir: 'in' | 'out'; type: ArgdownRelationType }> = [
  { tok: '+>', dir: 'in', type: 'supports' },
  { tok: '->', dir: 'in', type: 'attacks' },
  { tok: '_>', dir: 'in', type: 'undercuts' },
  { tok: '<+', dir: 'out', type: 'supports' },
  { tok: '<-', dir: 'out', type: 'attacks' },
  { tok: '<_', dir: 'out', type: 'undercuts' },
  { tok: '+', dir: 'out', type: 'supports' },
  { tok: '-', dir: 'out', type: 'attacks' },
];

// Relation lines start at the beginning of the (indentation-stripped) line, same as argdown-core's
// lexer (relations only match "at BOF or after a newline", lexer.ts:139). `><` is included here so
// it's recognized as a relation-shaped line (and reported) rather than silently falling through to
// the "plain prose" catch-all below.
const RELATION_LINE = /^(\s*)(\+>|->|_>|<\+|<-|<_|><|\+|-)\s*(.*)$/;
const TITLE_DEF = /^(\[([^\]]+)\]|<([^>]+)>)\s*:\s*(.*)$/;
const TITLE_REF = /^@?(\[([^\]]+)\]|<([^>]+)>)\s*$/;
const INLINE_REF = /^@?(\[([^\]]+)\]|<([^>]+)>)\s*(:\s*.*)?$/;
// PCS (premise-conclusion-structure) markers: numbered premises/conclusions `(1) ...` and the
// `--`/`----`/`-- rule --` inference-rule separator. Neither is part of this parser's grammar;
// both are reported once per parse (not per line) as "unsupported, ignored".
const PCS_PREMISE = /^\(\d+\)/;
const PCS_INFERENCE_RULE = /^-{2,}/;

interface StackItem {
  id: string;
  indent: number;
}

/** Parse one `.argdown` source (or one fenced ```argdown block's inner text) into its items + relations. */
export function parseArgdown(text: string): ParsedArgdown {
  const items = new Map<string, ArgdownItem>();
  const relKeys = new Set<string>();
  const relations: ArgdownRelation[] = [];
  const problems: ArgdownProblem[] = [];
  const stack: StackItem[] = [];
  // Set when a blank line closes an open relation block (stack was non-empty). Real @argdown/core
  // rejects any relation line that would otherwise attach across that blank (confirmed against the
  // real parser in test/argdown-parser.test.ts); cleared the moment a fresh title definition/
  // reference gives the parse a new, legitimate parent to hang relations off of. Left `false` for a
  // relation line with no stack and no preceding blank (e.g. the very first line of the file) --
  // @argdown/core silently emits no relation there too, so that case stays unreported.
  let brokenByBlank = false;
  let pcsReported = false;

  const ensure = (kind: ArgdownItemKind, title: string, line: number): string => {
    const id = title;
    if (!items.has(id)) items.set(id, { id, kind, title, line, definitions: [] });
    return id;
  };
  const define = (id: string, line: number, text: string): void => {
    items.get(id)!.definitions.push({ line, text: text.trim() });
  };
  // T67: real @argdown/core keeps self-relations uniformly (A -> A support/attack/undercut all
  // survive; confirmed by running the real parser -- prior-art.md #1), so dropping `from === to`
  // here was this parser's own bug, not a grammar-subset choice. A self-attack in particular is
  // Dung/ASPIC+/Carneades-meaningful (an argument that refutes itself) and must reach the graph.
  const addRelation = (from: string, to: string, type: ArgdownRelationType, line: number): void => {
    if (!from || !to) return;
    const key = `${from}\0${to}\0${type}`;
    if (relKeys.has(key)) return;
    relKeys.add(key);
    relations.push({ from, to, type, line });
  };
  const pushScope = (id: string, indent: number): void => {
    while (stack.length > 0 && stack[stack.length - 1]!.indent >= indent) stack.pop();
    stack.push({ id, indent });
    brokenByBlank = false; // a fresh title def/ref is a legitimate new parent, even after a break
  };

  const lines = text.split(/\r?\n/);
  for (let i = 0; i < lines.length; i++) {
    const raw = lines[i] ?? '';
    const line = i + 1;
    if (!raw.trim()) {
      if (stack.length > 0) {
        stack.length = 0;
        brokenByBlank = true;
      }
      continue;
    }
    const trimmed = raw.trim();

    // PCS (premise-conclusion-structure) / inference lines: not this parser's grammar at all.
    // Reported once per parse (not once per line) -- same intent as @argdown/core's own
    // "non-fatal, keep going" diagnostics, just collapsed to a single pointer at the first line.
    if (PCS_PREMISE.test(trimmed) || PCS_INFERENCE_RULE.test(trimmed)) {
      if (!pcsReported) {
        problems.push({ line, message: 'premise-conclusion-structure (PCS) / inference lines are not supported by this Argdown subset; ignored (first occurrence shown)' });
        pcsReported = true;
      }
      continue;
    }

    const relM = RELATION_LINE.exec(raw);
    if (relM) {
      const indent = relM[1]!.length;
      const tok = relM[2]!;
      const rest = relM[3]!.trim();
      if (tok === '><') {
        problems.push({ line, message: "'><' (contradiction) is a logical, not dialectical, relation and is intentionally unsupported by this EdgeType (supports/attacks/undercuts only); ignored" });
        continue;
      }
      const found = REL_TOKENS.find((t) => t.tok === tok);
      const refM = found ? INLINE_REF.exec(rest) : null;
      if (found && refM && stack.length > 0) {
        while (stack.length > 0 && stack[stack.length - 1]!.indent >= indent) stack.pop();
        const parent = stack[stack.length - 1];
        if (parent) {
          const kind: ArgdownItemKind = refM[2] !== undefined ? 'statement' : 'argument';
          const title = (refM[2] ?? refM[3])!;
          const childId = ensure(kind, title, line);
          if (refM[4] !== undefined) define(childId, line, refM[4].replace(/^:\s*/, ''));
          const [from, to] = found.dir === 'in' ? [parent.id, childId] : [childId, parent.id];
          addRelation(from, to, found.type, line);
          stack.push({ id: childId, indent });
          continue;
        }
      }
      if (!found) {
        problems.push({ line, message: `unrecognized relation token '${tok}'; ignored` });
      } else if (brokenByBlank) {
        problems.push({ line, message: `blank line broke the enclosing relation block (as @argdown/core also rejects); '${tok}' relation on this line was not attached` });
      } else {
        // no enclosing item at a smaller indent (e.g. an unindented `+ [B]` under `[A]`, or a relation on the
        // file's first line) or no [title]/<title> reference: @argdown/core reports a parser error here too.
        problems.push({ line, message: `'${tok}' relation has no enclosing statement/argument at a smaller indent (relations must be indented under their target) or no [title]/<title> reference; not attached` });
      }
      continue;
    }

    const indentMatch = /^(\s*)/.exec(raw)!;
    const indent = indentMatch[1]!.length;
    const content = raw.slice(indent);

    const defM = TITLE_DEF.exec(content);
    if (defM) {
      const kind: ArgdownItemKind = defM[2] !== undefined ? 'statement' : 'argument';
      const title = (defM[2] ?? defM[3])!;
      const id = ensure(kind, title, line);
      define(id, line, defM[4] ?? '');
      pushScope(id, indent);
      continue;
    }
    const refM = TITLE_REF.exec(content);
    if (refM) {
      const kind: ArgdownItemKind = refM[2] !== undefined ? 'statement' : 'argument';
      const title = (refM[2] ?? refM[3])!;
      pushScope(ensure(kind, title, line), indent);
      continue;
    }
    // Plain prose (wrapped title text, free commentary): not part of the relation graph this
    // loader builds; left unparsed, same as the unrecognized-reference case above.
  }

  return { items: [...items.values()], relations, problems };
}
