// T40 drift policy (Swimm Auto-sync pattern): a record pinned to a symbol is re-checked against the live code.
// Trivial drift (the symbol still exists with the same shape -- same kind, same parameter count -- just a
// different implementation) is safe to auto-sync silently: the record's content is still about the same thing.
// Real drift (the symbol is gone, renamed away, or its signature changed) is escalated: auto-syncing it would
// silently keep a record that no longer describes what it claims to. No model anywhere in this file.
import ts from 'typescript';

export type DriftStatus = 'none' | 'trivial' | 'real';
export interface DriftResult {
  status: DriftStatus;
  reason: string;
}

interface Shape {
  kind: 'function' | 'method' | 'class' | 'variable';
  paramCount: number;
}

/** A minimal, deterministic shape of a tail inside `text` (dotted tails address a class method, e.g. "Widget.render"). */
function shapeOf(text: string, tail: string): Shape | undefined {
  const sf = ts.createSourceFile('f.ts', text, ts.ScriptTarget.Latest, true, ts.ScriptKind.TS);
  const [owner, method] = tail.includes('.') ? tail.split('.', 2) : [undefined, tail];
  let found: Shape | undefined;
  const visit = (node: ts.Node): void => {
    if (ts.isFunctionDeclaration(node) && node.name?.text === tail && !owner) found = { kind: 'function', paramCount: node.parameters.length };
    else if (ts.isClassDeclaration(node) && node.name?.text === owner) {
      for (const m of node.members) {
        if (ts.isMethodDeclaration(m) && ts.isIdentifier(m.name) && m.name.text === method) found = { kind: 'method', paramCount: m.parameters.length };
      }
    } else if (ts.isVariableStatement(node)) {
      for (const d of node.declarationList.declarations) {
        if (ts.isIdentifier(d.name) && d.name.text === tail && !owner && d.initializer && (ts.isArrowFunction(d.initializer) || ts.isFunctionExpression(d.initializer))) {
          found = { kind: 'function', paramCount: d.initializer.parameters.length };
        }
      }
    }
    ts.forEachChild(node, visit);
  };
  visit(sf);
  return found;
}

/** Classify drift between a record's recorded snapshot (`beforeText`) and the code today (`afterText`) for the
 *  symbol named `tail`. `path` is informational only (used in the reason string). */
export function classifyDrift(path: string, beforeText: string, afterText: string, tail: string): DriftResult {
  const before = shapeOf(beforeText, tail);
  const after = shapeOf(afterText, tail);
  if (!before) return { status: 'real', reason: `${path}#${tail}: the recorded snapshot does not even contain this symbol (bad anchor)` };
  if (!after) return { status: 'real', reason: `${path}#${tail} no longer exists (deleted or renamed away): the record's anchor cannot re-attach` };
  if (before.kind !== after.kind || before.paramCount !== after.paramCount) {
    return { status: 'real', reason: `${path}#${tail} changed shape (${before.kind}/${before.paramCount} params -> ${after.kind}/${after.paramCount} params): the decision may no longer describe what the code does` };
  }
  if (beforeText === afterText) return { status: 'none', reason: `${path}#${tail} unchanged` };
  return { status: 'trivial', reason: `${path}#${tail} kept its shape (${after.kind}, ${after.paramCount} params): implementation-only change, safe to auto-sync` };
}
