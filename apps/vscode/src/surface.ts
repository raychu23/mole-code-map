// T15: the VS Code side of the hover + gutter mark + since list. hover.ts holds the logic (no vscode import, unit-tested);
// this file only wires it: runs the Mole CLI (`check --worktree --json`, `memory --json`, `since --json`), draws gutter marks,
// answers hovers, and implements the two commands a hover may link to. Every failure goes to the output channel, never a popup.
import { execFile } from 'node:child_process';
import { join } from 'node:path';
import * as vscode from 'vscode';
import { MoleClient } from '@mole/daemon';
import type { MemoryEntry, SinceResult } from '@mole/memory';
import { HOVER_COMMANDS, Touched, type CheckJson, type HoverAgentIntent, type HoverNote } from './hover.js';
import { debounce, toRepoPath } from './paths.js';
import { documentSymbolTails, type DocSymbol } from './seen.js';

const GIT_SCHEME = 'mole-git';
/** A small filled circle in Mole's accent; a data URI, so the .vsix needs no extra asset. */
const GUTTER_SVG = 'data:image/svg+xml;base64,' + Buffer.from('<svg xmlns="http://www.w3.org/2000/svg" width="16" height="16"><circle cx="8" cy="8" r="4" fill="#d18616"/></svg>').toString('base64');

export interface SurfaceOptions {
  root: string;
  /** path of the Mole CLI (bundled daemon.cjs, or the repo build) */
  cli: string;
  stateDir?: string;
  log(m: string): void;
  /** the panel's since list receives each fresh `mole since --json` */
  onSince(r: SinceResult | undefined): void;
}

export class Surface {
  readonly touched: Touched;
  private readonly client: MoleClient;
  private readonly deco: vscode.TextEditorDecorationType;
  private memo?: Promise<MemoryEntry[]>;
  /** editor file -> number of marked ranges drawn (the hover check reads it: the API cannot read decorations back) */
  readonly drawn = new Map<string, number>();

  constructor(private readonly ctx: vscode.ExtensionContext, private readonly o: SurfaceOptions) {
    this.client = new MoleClient({ root: o.root, stateDir: o.stateDir });
    this.deco = vscode.window.createTextEditorDecorationType({
      gutterIconPath: vscode.Uri.parse(GUTTER_SVG),
      gutterIconSize: 'contain',
      overviewRulerColor: '#d18616',
      overviewRulerLane: vscode.OverviewRulerLane.Left,
    });
    this.touched = new Touched({
      daemonUp: () => this.client.running(),
      check: async () => {
        this.memo = undefined; // notes are re-read with every check
        return JSON.parse(await this.cli(['check', '--worktree', '--json'])) as CheckJson;
      },
      notes: (file) => this.notes(file),
      agentIntent: (file) => this.agentIntent(file),
      log: (m) => o.log(`hover: ${m}`),
    });
  }

  /** Run the Mole CLI with the editor's own Node; stdout, or a rejection. */
  cli(args: string[]): Promise<string> {
    return new Promise((ok, fail) => {
      execFile(process.execPath, [this.o.cli, ...args, '--root', this.o.root], { env: { ...process.env, ELECTRON_RUN_AS_NODE: '1' }, maxBuffer: 64 * 1024 * 1024, timeout: 60_000 }, (err, stdout, stderr) => {
        if (err) fail(new Error(`mole ${args[0]}: ${err.message.split('\n')[0]} ${String(stderr).slice(0, 300)}`));
        else ok(stdout);
      });
    });
  }

  /** Your notes on `file`, placed on the symbol's current lines (end line from VS Code's document symbols when available). */
  private async notes(file: string): Promise<HoverNote[]> {
    this.memo ??= this.cli(['memory', '--json']).then((s) => JSON.parse(s) as MemoryEntry[]);
    const here = (await this.memo).filter((e) => e.status !== 'invalid' && e.line !== undefined && (e.newPath ?? e.path) === file);
    if (here.length === 0) return [];
    let spans: ReturnType<typeof documentSymbolTails> = [];
    try {
      const uri = vscode.Uri.file(join(this.o.root, file));
      spans = documentSymbolTails((await vscode.commands.executeCommand<DocSymbol[]>('vscode.executeDocumentSymbolProvider', uri)) ?? []);
    } catch {
      // no symbol provider: a note marks its first line only
    }
    return here.map((e) => {
      const symbol = e.symbol ?? '';
      const tail = symbol.includes('#') ? symbol.slice(symbol.indexOf('#') + 1) : symbol;
      const start = e.line as number;
      const span = spans.find((s) => s.tail === tail && Math.abs(s.startLine + 1 - start) <= 2);
      return { file: e.file, symbol, path: file, status: e.status, changed: e.changed, text: e.text, startLine: start, endLine: span ? span.endLine + 1 : start };
    });
  }

  /** T39: what Entire/git-ai/Agent Trace recorded about `file`, re-checked like a note. */
  private async agentIntent(file: string): Promise<HoverAgentIntent[]> {
    let result: { statuses: Array<{ status: string; intent: { file: string; tail: string; startLine: number; endLine: number; source: string; sessionId: string; model?: string; prompt?: string } }> };
    try {
      result = JSON.parse(await this.cli(['agent-intent', file, '--json']));
    } catch {
      return []; // no Entire/git-ai/Agent Trace source here: nothing to show, not an error
    }
    return result.statuses.map((s) => ({ file, tail: s.intent.tail, startLine: s.intent.startLine, endLine: s.intent.endLine, source: s.intent.source, sessionId: s.intent.sessionId, status: s.status, model: s.intent.model, prompt: s.intent.prompt }));
  }

  /** Reload the check and redraw. Never throws. */
  async refresh(): Promise<boolean> {
    const ok = await this.touched.refresh();
    this.redraw();
    return ok;
  }

  /** Marks are drawn: drop them if the daemon stopped since (one ping), else redraw from the cache. */
  async recheck(): Promise<void> {
    if (this.touched.files().length > 0 && !(await this.client.running())) await this.refresh();
    else this.redraw();
  }

  async running(): Promise<boolean> {
    return this.client.running();
  }

  async stopDaemon(): Promise<void> {
    await this.client.call('shutdown').catch(() => undefined);
  }

  async refreshSince(): Promise<void> {
    try {
      this.o.onSince(JSON.parse(await this.cli(['since', '--json'])) as SinceResult);
    } catch (e) {
      this.o.log(`since: ${(e as Error).message}`);
    }
  }

  /** Gutter marks on every visible editor from the cached check (empty while the daemon is down). */
  redraw(): void {
    for (const ed of vscode.window.visibleTextEditors) {
      if (ed.document.uri.scheme !== 'file') continue;
      const rel = toRepoPath(this.o.root, ed.document.uri.fsPath);
      if (!rel) continue;
      const ranges = this.touched.ranges(rel).map((r) => new vscode.Range(r.startLine - 1, 0, Math.max(r.startLine, r.endLine) - 1, 0));
      ed.setDecorations(this.deco, ranges);
      this.drawn.set(rel, ranges.length);
    }
  }

  /** Hover on a marked line: the past fix, its test and source, the questions and your notes; links only to the Mole commands. */
  provideHover = async (doc: vscode.TextDocument, pos: vscode.Position): Promise<vscode.Hover | undefined> => {
    if (doc.uri.scheme !== 'file') return undefined;
    const rel = toRepoPath(this.o.root, doc.uri.fsPath);
    if (!rel) return undefined;
    const text = await this.touched.hover(rel, pos.line + 1);
    if (!text) return undefined;
    const ms = new vscode.MarkdownString(text);
    ms.isTrusted = { enabledCommands: [...HOVER_COMMANDS] };
    return new vscode.Hover(ms);
  };

  /** git output for the read-only mole-git: documents (a commit, or a file as of a commit). */
  private git(args: string[]): Promise<string> {
    return new Promise((ok, fail) => execFile('git', ['-C', this.o.root, ...args], { maxBuffer: 64 * 1024 * 1024 }, (err, out) => (err ? fail(err) : ok(out))));
  }

  /** mole.showCommit [sha]: the commit (message, stat, patch) in a read-only editor. */
  async showCommit(sha: string): Promise<void> {
    try {
      const doc = await vscode.workspace.openTextDocument(vscode.Uri.from({ scheme: GIT_SCHEME, path: `/${sha.slice(0, 12)}.diff`, query: `show=${sha}` }));
      await vscode.languages.setTextDocumentLanguage(doc, 'diff');
      await vscode.window.showTextDocument(doc, { preview: true, viewColumn: vscode.ViewColumn.One });
    } catch (e) {
      this.o.log(`show commit ${sha}: ${(e as Error).message}`);
    }
  }

  /** mole.openAt [file, line, sha?]: the file as of the fix commit (read-only) at the line; without sha (or if git fails) the working file. */
  async openAt(file: string, line: number, sha?: string): Promise<void> {
    const sel = new vscode.Range(Math.max(0, line - 1), 0, Math.max(0, line - 1), 0);
    try {
      const uri = sha ? vscode.Uri.from({ scheme: GIT_SCHEME, path: `/${file}`, query: `sha=${sha}` }) : vscode.Uri.file(join(this.o.root, file));
      await vscode.window.showTextDocument(await vscode.workspace.openTextDocument(uri), { preview: true, selection: sel, viewColumn: vscode.ViewColumn.One });
    } catch (e) {
      this.o.log(`open ${file}:${line}@${sha ?? 'worktree'}: ${(e as Error).message}`);
      try {
        await vscode.window.showTextDocument(vscode.Uri.file(join(this.o.root, file)), { selection: sel, viewColumn: vscode.ViewColumn.One });
      } catch {
        // file gone in the working tree: nothing to open
      }
    }
  }

  /** Register the hover, the commands, the mole-git: documents and the refresh triggers. */
  register(): void {
    const provider: vscode.TextDocumentContentProvider = {
      provideTextDocumentContent: async (uri) => {
        const q = new URLSearchParams(uri.query);
        try {
          if (q.get('show')) return await this.git(['show', '--no-color', '--stat', '--patch', String(q.get('show'))]);
          return await this.git(['show', `${q.get('sha')}:${uri.path.replace(/^\//, '')}`]);
        } catch (e) {
          return `mole: git show failed: ${(e as Error).message}`;
        }
      },
    };
    const refreshAll = debounce(() => void (this.refresh(), this.refreshSince()), 800);
    this.ctx.subscriptions.push(
      this.deco,
      vscode.workspace.registerTextDocumentContentProvider(GIT_SCHEME, provider),
      vscode.languages.registerHoverProvider({ scheme: 'file' }, { provideHover: this.provideHover }),
      vscode.commands.registerCommand('mole.showCommit', (sha: string) => this.showCommit(String(sha))),
      vscode.commands.registerCommand('mole.openAt', (file: string, line: number, sha?: string) => this.openAt(String(file), Number(line), sha ? String(sha) : undefined)),
      vscode.workspace.onDidSaveTextDocument(() => refreshAll()),
      vscode.window.onDidChangeWindowState((st) => {
        if (st.focused) refreshAll();
      }),
      vscode.window.onDidChangeVisibleTextEditors(() => this.redraw()),
    );
  }
}
