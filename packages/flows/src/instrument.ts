// Source transform: wraps every function body with enter/exit hooks of the flows runtime (global `__mf`, runtime.ts).
// Ids follow the static graph (@mole/indexer ts-engine describe()): a function nested in another node has no id of its
// own and runs as a frame of that node, so a runtime edge names the same caller the static graph would.
// Only text insertions, never a newline: every line keeps its number (stack traces and file:line evidence stay right).
import ts from 'typescript';
import type { InstrumentResult } from './types.js';

type OwnerKind = 'function' | 'method' | 'class' | 'variable' | 'file';
interface Owner {
  id: string;
  kind: OwnerKind;
}
interface Edit {
  pos: number;
  text: string;
  close: boolean;
  depth: number;
  seq: number;
}
/** frame of the function being walked: what awaits/yields/catch blocks refer to */
interface FnCtx {
  async: boolean;
  generator: boolean;
  /** async generator or implicit awaits (for await / await using): no await rewriting, the runtime mutes the frame */
  mute: boolean;
}

const F = '__F';
const RT = '__mf';

function unwrap(e: ts.Expression): ts.Expression {
  let cur = e;
  for (;;) {
    if (ts.isParenthesizedExpression(cur) || ts.isNonNullExpression(cur) || ts.isAsExpression(cur) || ts.isTypeAssertionExpression(cur) || ts.isSatisfiesExpression(cur)) cur = cur.expression;
    else return cur;
  }
}

function memberName(n: ts.PropertyName | ts.BindingName | undefined): string | undefined {
  if (!n) return undefined;
  if (ts.isIdentifier(n) || ts.isStringLiteral(n) || ts.isNumericLiteral(n) || ts.isPrivateIdentifier(n)) return n.text;
  return undefined;
}

const hasModifier = (n: ts.Node, k: ts.SyntaxKind): boolean => !!ts.canHaveModifiers(n) && !!ts.getModifiers(n)?.some((m) => m.kind === k);

type FnLike = ts.FunctionDeclaration | ts.FunctionExpression | ts.ArrowFunction | ts.MethodDeclaration | ts.ConstructorDeclaration | ts.GetAccessorDeclaration | ts.SetAccessorDeclaration;
const isFnLike = (n: ts.Node): n is FnLike =>
  ts.isFunctionDeclaration(n) || ts.isFunctionExpression(n) || ts.isArrowFunction(n) || ts.isMethodDeclaration(n) || ts.isConstructorDeclaration(n) || ts.isGetAccessorDeclaration(n) || ts.isSetAccessorDeclaration(n);

/** an await/yield/call that executes when the expression is evaluated (nested function bodies excluded) */
function runsCode(n: ts.Node): boolean {
  let found = false;
  const walk = (c: ts.Node): void => {
    if (found || isFnLike(c) || ts.isClassLike(c)) return;
    if (ts.isCallExpression(c) || ts.isNewExpression(c) || ts.isTaggedTemplateExpression(c) || ts.isPropertyAccessExpression(c) || ts.isElementAccessExpression(c) || ts.isJsxElement(c) || ts.isJsxSelfClosingElement(c)) {
      found = true;
      return;
    }
    ts.forEachChild(c, walk);
  };
  walk(n);
  return found;
}

/** for await / await using directly in this function body: suspensions the transform cannot see */
function hasImplicitAwait(body: ts.Node): boolean {
  let found = false;
  const walk = (c: ts.Node): void => {
    if (found || isFnLike(c) || ts.isClassLike(c)) return;
    if (ts.isForOfStatement(c) && c.awaitModifier) found = true;
    else if (ts.isVariableDeclarationList(c) && (c.flags & ts.NodeFlags.AwaitUsing) === ts.NodeFlags.AwaitUsing) found = true;
    else ts.forEachChild(c, walk);
  };
  walk(body);
  return found;
}

function scriptKind(path: string): ts.ScriptKind {
  if (/\.tsx$/.test(path)) return ts.ScriptKind.TSX;
  if (/\.jsx$/.test(path)) return ts.ScriptKind.JSX;
  if (/\.[cm]?js$/.test(path)) return ts.ScriptKind.JS;
  return ts.ScriptKind.TS;
}

/**
 * Instrument one module. `relPath` = path relative to the repo root (forward slashes); `idPath` = the path ids are
 * written with (a built dist/x.js maps to its src/x.ts). Returns null when there is nothing to run.
 */
export function instrumentSource(code: string, relPath: string, opts: { idPath?: string; muted?: boolean } = {}): InstrumentResult | null {
  const idPath = opts.idPath ?? relPath;
  const sf = ts.createSourceFile(relPath, code, ts.ScriptTarget.Latest, true, scriptKind(relPath));
  if (sf.statements.length === 0) return null;
  const edits: Edit[] = [];
  let seq = 0;
  const add = (pos: number, text: string, close: boolean, depth: number): void => {
    edits.push({ pos, text, close, depth, seq: seq++ });
  };
  let functions = 0;
  const fileOwner: Owner = { id: `file:${idPath}#${idPath}`, kind: 'file' };

  const topLevel = (n: ts.Node): boolean => ts.isSourceFile(n.parent) || ts.isModuleBlock(n.parent);
  const modPrefix = (n: ts.Node): string => {
    const p = n.parent;
    return ts.isModuleBlock(p) && ts.isModuleDeclaration(p.parent) && ts.isStringLiteral(p.parent.name) ? `${p.parent.name.text}::` : '';
  };
  const mk = (kind: OwnerKind, qualified: string, at: ts.Node): Owner => {
    const q = (ts.isSourceFile(at.parent) || ts.isModuleBlock(at.parent) ? modPrefix(at) : modPrefix(at.parent)) + qualified;
    return { id: `${kind}:${idPath}#${q}`, kind };
  };
  const classOwner = (m: ts.Node): string | undefined => {
    const p = m.parent;
    if (ts.isClassDeclaration(p) && p.name && topLevel(p)) return p.name.text;
    return undefined;
  };
  /** same rules as @mole/indexer describe(): which graph node (if any) a declaration is */
  const tracked = (d: ts.Node): Owner | undefined => {
    if (ts.isFunctionDeclaration(d) && d.name && topLevel(d)) return mk('function', d.name.text, d);
    if (ts.isClassDeclaration(d) && d.name && topLevel(d)) return mk('class', d.name.text, d);
    if (ts.isConstructorDeclaration(d)) {
      const o = classOwner(d);
      return o ? mk('method', `${o}.constructor`, d) : undefined;
    }
    if (ts.isMethodDeclaration(d) || ts.isGetAccessorDeclaration(d) || ts.isSetAccessorDeclaration(d)) {
      const o = classOwner(d);
      const n = memberName(d.name);
      return o && n ? mk('method', `${o}.${n}`, d) : undefined;
    }
    if (ts.isPropertyDeclaration(d)) {
      const o = classOwner(d);
      const n = memberName(d.name);
      if (!o || !n) return undefined;
      const init = d.initializer ? unwrap(d.initializer) : undefined;
      const fnLike = (init && (ts.isArrowFunction(init) || ts.isFunctionExpression(init))) || (d.type && ts.isFunctionTypeNode(d.type));
      return fnLike ? mk('method', `${o}.${n}`, d) : undefined;
    }
    if (ts.isVariableDeclaration(d) && ts.isIdentifier(d.name)) {
      const list = d.parent;
      const stmt = list.parent;
      if (!ts.isVariableDeclarationList(list) || !ts.isVariableStatement(stmt) || !topLevel(stmt)) return undefined;
      const init = d.initializer ? unwrap(d.initializer) : undefined;
      const isFn = init && (ts.isArrowFunction(init) || ts.isFunctionExpression(init));
      return mk(isFn ? 'function' : 'variable', d.name.text, stmt);
    }
    return undefined;
  };
  /** a lambda frame of `o`: closures of functions/methods only attribute; registry entries (variable/class/file) also record */
  const lambdaCall = (o: Owner, async: boolean): string => {
    if (opts.muted) return `${RT}.q(${JSON.stringify(o.id)})`;
    const registry = o.kind === 'variable' || o.kind === 'class' || o.kind === 'file';
    return `${RT}.${registry ? (async ? 'K' : 'k') : async ? 'L' : 'l'}(${JSON.stringify(o.id)})`;
  };

  /** `{ body }` -> `{ const __F = enter; try { body } finally { leave } }` (an empty body gets one edit: open and close share a position) */
  const wrapBlock = (b: ts.Block, call: string, depth: number): void => {
    const open = b.getStart(sf) + 1;
    const close = b.end - 1;
    if (close <= open) add(open, `const ${F}=${call};try{}finally{${RT}.x(${F})}`, false, depth);
    else {
      add(open, `const ${F}=${call};try{`, false, depth);
      add(close, `}finally{${RT}.x(${F})}`, true, depth);
    }
  };

  /** wrap an expression that runs code (field / parameter initializer) in a frame of `o` */
  const wrapExpr = (e: ts.Expression, o: Owner, depth: number): void => {
    if (!runsCode(e)) return;
    add(e.getStart(sf), `(()=>{const ${F}=${lambdaCall(o, false)};try{return (`, false, depth);
    add(e.end, `)}finally{${RT}.x(${F})}})()`, true, depth);
  };

  const instrumentFn = (fn: FnLike, owner: Owner, self: Owner | undefined, depth: number): FnCtx | undefined => {
    const body = fn.body;
    if (!body) return undefined;
    const async = hasModifier(fn, ts.SyntaxKind.AsyncKeyword);
    const generator = !!(fn as ts.FunctionLikeDeclarationBase).asteriskToken;
    const mute = (async && generator) || (async && hasImplicitAwait(body));
    let call: string;
    if (opts.muted && !mute) call = `${RT}.q(${JSON.stringify((self ?? owner).id)})`;
    else if (mute) {
      const id = self ? self.id : owner.id;
      call = `${RT}.m(${JSON.stringify(id)},${self ? 1 : 0})`;
    } else if (self && ts.isConstructorDeclaration(fn)) {
      // `new C()` is named class:...#C in the static graph; `super()` from a subclass reaches C.constructor
      const cls = fn.parent as ts.ClassDeclaration;
      const classId = self.id.replace(/^method:/, 'class:').replace(/\.constructor$/, '');
      call = `${RT}.n(${JSON.stringify(self.id)},new.target===${cls.name!.text}?${JSON.stringify(classId)}:null)`;
    } else if (self) call = `${RT}.e(${JSON.stringify(self.id)})`;
    else call = lambdaCall(owner, async || generator);
    functions++;
    // parameter defaults run before the body: give them the same frame owner (lambda semantics, no edge)
    const frameOwner: Owner = self ? { id: self.id, kind: 'method' } : owner;
    const visitParam = (p: ts.Node): void => {
      if ((ts.isParameter(p) || ts.isBindingElement(p)) && p.initializer) wrapExpr(p.initializer, frameOwner, depth + 1);
      if (!isFnLike(p)) ts.forEachChild(p, visitParam);
    };
    for (const p of fn.parameters) visitParam(p);
    if (ts.isBlock(body)) wrapBlock(body, call, depth);
    else {
      add(body.getStart(sf), `{const ${F}=${call};try{return (`, false, depth);
      add(body.end, `)}finally{${RT}.x(${F})}}`, true, depth);
    }
    return { async, generator, mute };
  };

  const visit = (node: ts.Node, owner: Owner, fn: FnCtx | undefined, depth: number): void => {
    let cur = owner;
    let curFn = fn;
    const t = tracked(node);
    if (t) cur = t;

    if (isFnLike(node)) {
      if (!node.body || hasModifier(node, ts.SyntaxKind.DeclareKeyword)) return;
      // is this function the body of a tracked node? (declaration itself, or the initializer of a tracked const/property)
      let self: Owner | undefined;
      if (t && t.kind !== 'class') self = t;
      else if (ts.isArrowFunction(node) || ts.isFunctionExpression(node)) {
        let p: ts.Node = node.parent;
        while (ts.isParenthesizedExpression(p) || ts.isAsExpression(p) || ts.isSatisfiesExpression(p) || ts.isNonNullExpression(p) || ts.isTypeAssertionExpression(p)) p = p.parent;
        if ((ts.isVariableDeclaration(p) || ts.isPropertyDeclaration(p)) && p.initializer && unwrap(p.initializer) === node && owner.kind !== 'file') {
          const pt = tracked(p);
          if (pt && (pt.kind === 'function' || pt.kind === 'method') && pt.id === owner.id) self = pt;
        }
      }
      const ctx = instrumentFn(node, owner, self, depth);
      if (!ctx) return;
      curFn = ctx;
      cur = self ?? owner;
      ts.forEachChild(node, (c) => visit(c, cur, curFn, depth + 1));
      return;
    }

    if (ts.isPropertyDeclaration(node) && node.initializer) {
      const init = unwrap(node.initializer);
      // a fn-like property is the method itself (handled when the walk reaches the arrow); other initializers run
      // during construction (or class definition, if static) and belong to the property's node: the method, or the class
      if (!(ts.isArrowFunction(init) || ts.isFunctionExpression(init))) wrapExpr(node.initializer, t ?? owner, depth + 1);
    }
    if (ts.isClassStaticBlockDeclaration(node)) {
      wrapBlock(node.body, lambdaCall(owner, false), depth);
      ts.forEachChild(node, (c) => visit(c, owner, { async: false, generator: false, mute: false }, depth + 1));
      return;
    }

    if (curFn && !curFn.mute) {
      if (ts.isAwaitExpression(node) && curFn.async) {
        add(node.getStart(sf), `${RT}.r(${F},`, false, depth);
        add(node.expression.getStart(sf), `${RT}.s(${F},`, false, depth + 0.5);
        add(node.expression.end, ')', true, depth + 0.5);
        add(node.end, ')', true, depth);
      } else if (ts.isYieldExpression(node) && curFn.generator) {
        const kwEnd = node.asteriskToken ? node.asteriskToken.end : node.getStart(sf) + 'yield'.length;
        add(node.getStart(sf), `${RT}.r(${F},`, false, depth);
        if (node.expression) {
          add(kwEnd, ` ${RT}.s(${F},`, false, depth + 0.5);
          add(node.expression.end, ')', true, depth + 0.5);
        } else add(kwEnd, ` ${RT}.s(${F},void 0)`, false, depth + 0.5);
        add(node.end, ')', true, depth);
      } else if ((curFn.async || curFn.generator) && ts.isCatchClause(node)) {
        add(node.block.getStart(sf) + 1, `${RT}.c(${F});`, false, depth);
      } else if ((curFn.async || curFn.generator) && ts.isTryStatement(node) && node.finallyBlock) {
        add(node.finallyBlock.getStart(sf) + 1, `${RT}.c(${F});`, false, depth);
      }
    }
    ts.forEachChild(node, (c) => visit(c, cur, curFn, depth + 1));
  };

  // module code (imports evaluated, top-level statements) runs in a muted frame: no edges from module initialisation
  const first = sf.statements[0]!;
  const last = sf.statements[sf.statements.length - 1]!;
  // the setup file installs the runtime before any test module loads; a module imported earlier (or outside a recorded
  // run) gets no-op hooks, which the real runtime replaces when it is installed
  const NOOP = `globalThis.${RT}||(globalThis.${RT}={e:()=>0,n:()=>0,l:()=>0,L:()=>0,k:()=>0,K:()=>0,m:()=>0,q:()=>0,mm:()=>0,s:(f,v)=>v,r:(f,v)=>v,c:()=>{},x:()=>{}});`;
  add(first.getFullStart() + (code.startsWith('#!') ? code.indexOf('\n') + 1 : 0), `${NOOP}var __M=${RT}.mm();`, false, -1);
  for (const s of sf.statements) visit(s, fileOwner, undefined, 0);
  add(last.end, `;${RT}.x(__M);`, true, -1);

  edits.sort((a, b) => a.pos - b.pos || (a.close === b.close ? (a.close ? b.depth - a.depth : a.depth - b.depth) || a.seq - b.seq : a.close ? -1 : 1));
  let out = '';
  let at = 0;
  for (const e of edits) {
    out += code.slice(at, e.pos) + e.text;
    at = e.pos;
  }
  out += code.slice(at);
  return { code: out, functions };
}
