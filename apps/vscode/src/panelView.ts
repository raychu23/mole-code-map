// T34 one-panel: the sidebar WebviewViewProvider. Shows, for the function under the cursor, everything Mole
// knows about it (D31, the center of everything): decisions -> past fixes -> notes -> since -> questions ->
// tests -> agents -> blast radius, plus decision-rule violations in the Problems panel. The existing
// MolePanel (mole.openMap) is untouched; this is an additional, always-visible Activity Bar view.
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { execFile } from 'node:child_process';
import { join } from 'node:path';
import * as vscode from 'vscode';
import type { MoleClient } from '@mole/daemon';
import { buildPanelModel, type BuildTarget, type PanelModel, type Runners } from './panelData.js';
import { makeRunners, type CliHandle } from './panelRunners.js';
import { toRepoPath } from './paths.js';
import { documentSymbolTails, spanAt, type DocSymbol } from './seen.js';

const TS_LANGS = new Set(['typescript', 'typescriptreact']);
export const PANEL_VIEW_ID = 'mole.panelView';

function gitHeadShort(root: string): Promise<string> {
  return new Promise((resolve) => {
    execFile('git', ['rev-parse', '--short', 'HEAD'], { cwd: root, timeout: 3000 }, (err, stdout) => resolve(err ? 'no-git' : stdout.trim()));
  });
}

export class MolePanelView implements vscode.WebviewViewProvider {
  private view?: vscode.WebviewView;
  private runners: Runners;
  private cache = new Map<string, PanelModel>(); // key: `${root}@${commit}:${file}:${symbol ?? ''}`
  private seq = 0;
  private waiters = new Map<number, (ms: number) => void>();
  private pendingTriggerAt = new Map<number, number>();
  refreshMsSamples: number[] = [];
  lastModel?: PanelModel;
  /** T62 screenshot proof: scroll the webview to one section (m26 check mode only) */
  scrollTo(sectionId: string): void {
    void this.view?.webview.postMessage({ type: 'scrollTo', id: sectionId });
  }
  readonly diagnostics = vscode.languages.createDiagnosticCollection('mole-rules');

  constructor(
    private readonly ctx: vscode.ExtensionContext,
    private readonly root: string,
    private readonly cli: CliHandle,
    clientFn: () => MoleClient | undefined,
    private readonly log: (m: string) => void,
  ) {
    this.runners = makeRunners(cli, clientFn);
  }

  resolveWebviewView(view: vscode.WebviewView): void {
    this.view = view;
    view.webview.options = { enableScripts: true, localResourceRoots: [vscode.Uri.joinPath(this.ctx.extensionUri, 'dist')] };
    view.webview.html = this.html(view.webview);
    view.webview.onDidReceiveMessage((m: { type: string; [k: string]: unknown }) => void this.onMessage(m));
    view.onDidDispose(() => (this.view = undefined));
    if (this.lastModel) void this.post(this.lastModel, this.seq);
  }

  private html(webview: vscode.Webview): string {
    const nonce = Math.random().toString(36).slice(2);
    const script = webview.asWebviewUri(vscode.Uri.joinPath(this.ctx.extensionUri, 'dist', 'panel.js'));
    return `<!doctype html><html><head><meta charset="utf-8"><meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src 'unsafe-inline'; script-src 'nonce-${nonce}';"><style>
body{font-family:var(--vscode-font-family);font-size:12px;color:var(--vscode-foreground)}
.hdr{font-weight:600;padding:4px 0;border-bottom:1px solid var(--vscode-panel-border)}
.sec{padding:6px 0;border-bottom:1px solid var(--vscode-panel-border)}
.sec h3{margin:0;font-size:12px}
.status{opacity:.6;font-weight:400;font-size:10px}
.caption{opacity:.75;margin:2px 0}
.msg{color:var(--vscode-errorForeground)}
.sec-error .msg{color:var(--vscode-errorForeground)}
.sec-unavailable .msg,.sec-empty .msg{opacity:.7}
textarea{width:100%;min-height:40px}
.reasoning ul{margin:2px 0;padding-left:16px}.reasoning h4{margin:6px 0 2px;font-size:12px}.rs-from,.rs-order,.rs-none,.rs-args,.rs-text{opacity:.75}.rs-order{margin:0}.arg{font-family:var(--vscode-editor-font-family)}.reasoning code{display:block;font-family:var(--vscode-editor-font-family);background:var(--vscode-textCodeBlock-background);padding:1px 4px;margin:2px 0;user-select:all}
</style></head><body><div id="app">loading…</div><script nonce="${nonce}" src="${script}"></script></body></html>`;
  }

  private async onMessage(m: { type: string; [k: string]: unknown }): Promise<void> {
    if (m.type === 'rendered') {
      const resolve = this.waiters.get(Number(m.seq));
      const t0 = this.pendingTriggerAt.get(Number(m.seq));
      if (t0 !== undefined) {
        this.refreshMsSamples.push(Date.now() - t0);
        this.pendingTriggerAt.delete(Number(m.seq));
      }
      resolve?.(Number(m.paintMs));
      this.waiters.delete(Number(m.seq));
    } else if (m.type === 'error') {
      this.log(`mole panel webview error: ${String(m.message)}`);
    } else if (m.type === 'addNote') {
      await this.addNote(String(m.text));
    } else if (m.type === 'saveExplain') {
      this.saveExplain(String(m.text));
    } else if (m.type === 'runTests') {
      await this.runTests();
    } else if (m.type === 'reasoningWhatIf') {
      await this.reasoningWhatIf(String(m.order ?? ''));
    }
  }

  private lastTarget?: BuildTarget;

  /** T73: the panel's "compare with order X" what-if -- never writes; merges into the already-rendered model
   *  and re-posts it (the same patch-on-postMessage idiom every other refresh uses, M26b), so renderReasoning
   *  (webview/reasoning.ts) is the one place that knows how to show it. */
  private async reasoningWhatIf(orderCsv: string): Promise<void> {
    const order = orderCsv.split(',').map((s) => s.trim()).filter(Boolean);
    if (!this.lastModel || order.length === 0) return;
    const reasoning = this.lastModel.sections.reasoning;
    const data = { ...(reasoning.data as Record<string, unknown>) };
    try {
      const comparison = await this.runners.prioritiesWhatIf(order);
      data.whatIf = { order, comparison };
    } catch (e) {
      data.whatIf = { order, comparison: { error: (e as Error).message.split('\n')[0] } };
    }
    this.lastModel = { ...this.lastModel, sections: { ...this.lastModel.sections, reasoning: { ...reasoning, data } } };
    await this.post(this.lastModel, ++this.seq);
  }

  /** M26 check proof only: fills the what-if input and clicks Compare, the same deterministic-click idiom
   *  webview/main.ts's selftestClick uses for the map panel. Never called outside a scripted check. */
  triggerWhatIf(order: string): void {
    void this.view?.webview.postMessage({ type: 'selftestWhatIf', order });
  }

  private async addNote(text: string): Promise<void> {
    if (!this.lastTarget?.symbol) return;
    const at = `${this.lastTarget.file}#${this.lastTarget.symbol}`;
    try {
      await new Promise<void>((resolve, reject) => {
        execFile(this.cli.nodePath, [this.cli.cliPath, 'note', 'add', at, text, '--root', this.root], { env: { ...process.env, ELECTRON_RUN_AS_NODE: '1' } }, (err) => (err ? reject(err) : resolve()));
      });
    } catch (e) {
      this.log(`mole note add failed: ${(e as Error).message}`);
    }
    await this.refreshNow();
  }

  /** T31 stub: "explain it back" saves privately to .mole/local, never sent anywhere; T31 will read it back. */
  private saveExplain(text: string): void {
    try {
      const dir = join(this.root, '.mole', 'local');
      mkdirSync(dir, { recursive: true });
      const file = join(dir, 'explain-it-back.jsonl');
      const prior = existsSync(file) ? readFileSync(file, 'utf8') : '';
      const entry = { time: new Date().toISOString(), target: this.lastTarget ? `${this.lastTarget.file}${this.lastTarget.symbol ? `#${this.lastTarget.symbol}` : ''}` : undefined, text };
      writeFileSync(file, prior + JSON.stringify(entry) + '\n');
    } catch (e) {
      this.log(`mole explain-it-back save failed: ${(e as Error).message}`);
    }
  }

  /** The view's "Run" button: actually executes vitest (slow, on demand only — never during a passive
   *  refresh). The passive "tests that guard it" section uses Runners.testsAtLine (static selection, fast). */
  private async runTests(): Promise<void> {
    if (!this.lastTarget) return;
    try {
      const summary = await new Promise<string>((resolvePromise, reject) => {
        execFile(
          this.cli.nodePath,
          [this.cli.cliPath, 'check', '--worktree', '--run-tests', '--json', '--root', this.root],
          { env: { ...process.env, ELECTRON_RUN_AS_NODE: '1' }, timeout: 120_000, maxBuffer: 1 << 24 },
          (err, stdout) => {
            const text = stdout?.trim();
            if (!text) {
              reject(err ?? new Error('mole check --run-tests produced no output'));
              return;
            }
            try {
              const r = JSON.parse(text) as { run?: { passed?: number; failed?: number; notRun?: unknown[] } };
              const run = r.run;
              resolvePromise(run ? `${run.passed ?? 0} passed, ${run.failed ?? 0} failed${run.notRun?.length ? `, ${run.notRun.length} not run` : ''}` : 'no test reaches this change');
            } catch {
              resolvePromise('ran (could not parse the result)');
            }
          },
        );
      });
      void this.view?.webview.postMessage({ type: 'runResult', summary });
    } catch (e) {
      void this.view?.webview.postMessage({ type: 'runResult', summary: `failed: ${(e as Error).message}` });
    }
  }

  private symbolAt(nodes: DocSymbol[], line: number): string | undefined {
    const spans = documentSymbolTails(nodes);
    return spanAt(spans, line)?.tail;
  }

  /** Cursor moved / editor switched: compute (debounced by the caller) the panel for the new target. */
  async follow(editor: vscode.TextEditor | undefined): Promise<void> {
    if (!editor || editor.document.uri.scheme !== 'file' || !TS_LANGS.has(editor.document.languageId)) return;
    const rel = toRepoPath(this.root, editor.document.uri.fsPath);
    if (!rel) return;
    const line = editor.selection.active.line;
    let symbol: string | undefined;
    try {
      const nodes = (await vscode.commands.executeCommand<vscode.DocumentSymbol[]>('vscode.executeDocumentSymbolProvider', editor.document.uri)) ?? [];
      symbol = this.symbolAt(nodes as unknown as DocSymbol[], line);
    } catch {
      // no symbol provider: panel still works at file granularity
    }
    this.lastTarget = { root: this.root, file: rel, line: line + 1, symbol };
    await this.refreshNow();
  }

  private diagCommit?: string;

  private async refreshNow(): Promise<void> {
    if (!this.lastTarget) return;
    const target = this.lastTarget;
    const commit = await gitHeadShort(this.root);
    const key = `${commit}:${target.file}:${target.symbol ?? ''}`;
    const triggeredAt = Date.now();
    let model = this.cache.get(key);
    if (model) {
      model = { ...model, cacheHit: true };
    } else {
      model = await buildPanelModel(target, this.runners);
      this.cache.set(key, model);
      if (this.cache.size > 300) this.cache.clear();
    }
    this.lastModel = model;
    // the rules scan is per-commit, not per cursor position: skip it on a cache hit within the same commit so
    // a warm cursor move / same-file refresh never pays for a fresh dependency-cruiser pass (M26b).
    if (this.diagCommit !== commit) {
      this.diagCommit = commit;
      void this.updateDiagnostics();
    }
    const seq = ++this.seq;
    this.pendingTriggerAt.set(seq, triggeredAt);
    await this.post(model, seq);
  }

  private post(model: PanelModel, seq: number): Promise<void> {
    if (!this.view) return Promise.resolve();
    void this.view.webview.postMessage({ type: 'mole.update', model, seq });
    return new Promise((resolve) => {
      this.waiters.set(seq, () => resolve());
      setTimeout(() => {
        this.waiters.delete(seq);
        this.pendingTriggerAt.delete(seq); // a late ack after this must not land in a later measurement window
        resolve();
      }, 2000);
    });
  }

  /** `mole rules` violations -> the Problems panel, refreshed alongside the rest of the view. */
  private async updateDiagnostics(): Promise<void> {
    try {
      const r = (await this.runners.rules()) as { violations?: Array<{ file: string; line: number; rule: string; target: string; decision: { id?: string; why?: string } }> };
      const byFile = new Map<string, vscode.Diagnostic[]>();
      for (const v of r.violations ?? []) {
        const range = new vscode.Range(Math.max(0, v.line - 1), 0, Math.max(0, v.line - 1), 200);
        const msg = `mole rules: ${v.rule} forbids this (decision ${v.decision?.id ?? '?'}${v.decision?.why ? `: ${v.decision.why}` : ''}) — target ${v.target}`;
        const diag = new vscode.Diagnostic(range, msg, vscode.DiagnosticSeverity.Warning);
        diag.source = 'mole';
        const list = byFile.get(v.file) ?? [];
        list.push(diag);
        byFile.set(v.file, list);
      }
      this.diagnostics.clear();
      for (const [file, diags] of byFile) this.diagnostics.set(vscode.Uri.file(join(this.root, file)), diags);
    } catch {
      // a rules error already shows in the view's own section; the Problems panel just stays empty
    }
  }

  dispose(): void {
    this.diagnostics.dispose();
  }
}
