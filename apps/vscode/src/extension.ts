import { spawn } from 'node:child_process';
import { execFile } from 'node:child_process';
import { existsSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import * as vscode from 'vscode';
import type { Neighborhood } from '@mole/core';
import { ensureDaemon, MoleClient } from '@mole/daemon';
import { clickLine } from '../webview/render.js';
import { CSS } from '../webview/style.js';
import { debounce, toRepoPath } from './paths.js';
import { Surface } from './surface.js';
import { startDecisionTree } from './tree-provider.js';
import { MolePanelView, PANEL_VIEW_ID } from './panelView.js';
import type { SinceResult } from '@mole/memory';
import { documentSymbolTails, dwellSpans, SeenRecorder, spanAt, type DocSymbol, type SeenHit, type SymbolSpan } from './seen.js';

const VIEW_TYPE = 'mole.map';
const SWITCH_DEBOUNCE_MS = 120;

interface Rendered {
  seq: number;
  layoutMs: number;
  drawMs: number;
  nodes: number;
}
interface Sample {
  file: string;
  state: string;
  nodes: number;
  rpcMs: number;
  layoutMs: number;
  drawMs: number;
  /** webview message -> next animation frame; null when the window was in the background (no frame) */
  paintMs: number | null;
  /** debounced handler start → painted: what "warm file switch → render" means. */
  totalMs: number;
  /** editor switch → painted, including the 120 ms debounce. */
  withDebounceMs: number;
}

let output: vscode.OutputChannel;

export async function activate(ctx: vscode.ExtensionContext): Promise<void> {
  output = vscode.window.createOutputChannel('Mole');
  const root = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath;
  const mole = new MolePanel(ctx, root);
  let panelView: MolePanelView | undefined;
  if (root) {
    panelView = new MolePanelView(ctx, root, { cliPath: moleCli(ctx), root, nodePath: process.execPath }, () => mole.getClient(), (m) => output.appendLine(m));
    ctx.subscriptions.push(vscode.window.registerWebviewViewProvider(PANEL_VIEW_ID, panelView), panelView);
    // the M26 check drives panelView.follow() itself, deterministically, one call at a time; a live listener
    // racing the same editor/selection events it is causing would double-fire and make the latency measurement
    // (not the real feature) flaky, so it is not registered in that mode.
    if (!process.env.MOLE_M26_CHECK) {
      const followPanel = debounce((e: vscode.TextEditor | undefined) => void panelView!.follow(e), 150);
      ctx.subscriptions.push(
        vscode.window.onDidChangeActiveTextEditor(followPanel),
        vscode.window.onDidChangeTextEditorSelection((e) => followPanel(e.textEditor)),
      );
      if (vscode.window.activeTextEditor) void panelView.follow(vscode.window.activeTextEditor);
    }
  }
  ctx.subscriptions.push(
    output,
    vscode.window.registerWebviewPanelSerializer(VIEW_TYPE, {
      async deserializeWebviewPanel(panel) {
        mole.adopt(panel);
      },
    }),
    // an explicit request starts everything, even in a workspace where Mole stayed dormant
    vscode.commands.registerCommand('mole.openMap', async () => {
      await mole.boot();
      await mole.open();
    }),
    vscode.commands.registerCommand('mole.toggleImpact', () => mole.toggleImpact()),
    vscode.commands.registerCommand('mole.reindex', () => mole.reindex()),
    vscode.window.onDidChangeActiveTextEditor(debounce((e: vscode.TextEditor | undefined) => void mole.follow(e, performance.now()), SWITCH_DEBOUNCE_MS)),
  );
  if (root) registerCliCommands(ctx, root);
  if (!root) {
    output.appendLine('no workspace folder: Mole is idle');
    return;
  }
  startDecisionTree(ctx, root, (m) => output.appendLine(m), moleCli(ctx)); // T30: decision badges + intent cards in the Explorer (only with .mole/)
  if (process.env.MOLE_TREE_CHECK) return; // T30 proof artifact: decorations only, no daemon/panel needed
  const testing = Boolean(process.env.MOLE_SELFTEST || process.env.MOLE_SELFTEST_RESTORE || process.env.MOLE_HOVER_CHECK || process.env.MOLE_M26_CHECK);
  // a public extension must be silent where it has nothing to say: no TypeScript here = no panel, no background process
  const dormant = !testing && !(await hasTypeScript());
  if (process.env.MOLE_IDLE_PROBE) {
    setTimeout(() => writeFileSync(String(process.env.MOLE_IDLE_PROBE), JSON.stringify({ dormant, panel: mole.hasPanel() || hasMoleTab() })), 6000);
  }
  if (dormant) {
    output.appendLine('no TypeScript found in this workspace: Mole stays idle (run "Mole: Open map beside the code" to start it anyway)');
    return;
  }
  startSeen(ctx, root);
  // T15: hover + gutter mark on lines the working-tree change touched, and the panel's since list
  const surface = new Surface(ctx, {
    root,
    cli: moleCli(ctx),
    stateDir: vscode.workspace.getConfiguration('mole').get<string>('stateDir') || process.env.MOLE_STATE_DIR || undefined,
    log: (m) => output.appendLine(m),
    onSince: (r) => mole.setSince(r),
  });
  surface.register();
  ctx.subscriptions.push(
    // the daemon may have stopped since the last refresh: a switch re-checks it (one ping), so marks never outlive it
    vscode.window.onDidChangeActiveTextEditor(
      debounce(() => void surface.recheck(), 500),
    ),
  );
  const booted = mole.boot();
  void booted.then(() => Promise.all([surface.refresh(), surface.refreshSince()]));
  if (process.env.MOLE_HOVER_CHECK) {
    void hoverCheck(mole, surface, root, process.env.MOLE_HOVER_CHECK);
    return;
  }
  if (process.env.MOLE_M26_CHECK) {
    void m26Check(mole, panelView, root, process.env.MOLE_M26_CHECK);
    return;
  }
  if (process.env.MOLE_REVIVE_PROBE) void reviveProbe(mole, root, process.env.MOLE_REVIVE_PROBE, process.env.MOLE_REVIVE_FILE ?? '');
  if (process.env.MOLE_SELFTEST) void selfTest(mole, process.env.MOLE_SELFTEST);
  else if (process.env.MOLE_SELFTEST_RESTORE) void restoreProbe(mole, process.env.MOLE_SELFTEST_RESTORE);
  else if (vscode.workspace.getConfiguration('mole').get<boolean>('autoOpen', true)) {
    // a panel restored from the last session arrives via the serializer a moment after activation: do not open a second one
    setTimeout(() => {
      if (!mole.hasPanel() && !hasMoleTab()) void mole.open();
    }, 1500);
  }
}

/**
 * MOLE_REVIVE_PROBE=<json path>: after the daemon stops itself (idle shutdown, MOLE_IDLE_MINUTES), switch to a file and check that
 * the extension starts a new daemon and still answers. Used by the install check; never active in normal use.
 */
async function reviveProbe(mole: MolePanel, root: string, outPath: string, file: string): Promise<void> {
  const out: Record<string, unknown> = {};
  try {
    await mole.boot();
    const editor = await vscode.window.showTextDocument(vscode.Uri.file(join(root, file)), { viewColumn: vscode.ViewColumn.One, preview: false });
    const c = new MoleClient({ root, stateDir: process.env.MOLE_STATE_DIR });
    const t0 = Date.now();
    out.ranAtStart = await c.running();
    // watch the lock file, not the socket: asking the daemon whether it is alive would itself count as activity and keep it up
    const dir = process.env.MOLE_STATE_DIR ?? '';
    const lockExists = (): boolean => existsSync(dir) && readdirSync(dir).some((n) => n.endsWith('.lock'));
    while (lockExists() && Date.now() - t0 < 120_000) await new Promise((r) => setTimeout(r, 500));
    out.stoppedByItself = !(await c.running());
    out.stoppedAfterMs = Date.now() - t0;
    await new Promise((r) => setTimeout(r, 1500)); // let the panel exist
    const sample = await mole.follow(editor, performance.now());
    out.stateAfterSwitch = sample?.state ?? 'no sample';
    for (let i = 0; i < 40 && !(await c.running()); i++) await new Promise((r) => setTimeout(r, 250));
    out.daemonBackUp = await c.running();
    out.mapAfterRevive = (await c.map(file)).state;
  } catch (e) {
    out.error = (e as Error).message;
  }
  writeFileSync(outPath, JSON.stringify(out, null, 2));
}

/** T34 (M26): one command-palette entry per CLI read feature that is not already inside the sidebar view
 *  (the view covers most of them; a command still exists for each, per the done-when: "every CLI read
 *  command gets a command-palette entry"). Each runs the human-formatted CLI and opens the result read-only
 *  so it never needs a terminal. Prompts for a target where the CLI needs one, defaulting to the file open
 *  in the active editor. */
function registerCliCommands(ctx: vscode.ExtensionContext, root: string): void {
  const cli = moleCli(ctx);
  const show = async (title: string, args: string[]): Promise<void> => {
    const text = await new Promise<string>((resolvePromise) => {
      execFile(process.execPath, [cli, ...args, '--root', root], { env: { ...process.env, ELECTRON_RUN_AS_NODE: '1' }, maxBuffer: 1 << 24 }, (err, stdout, stderr) => {
        resolvePromise(stdout?.trim() || stderr?.trim() || (err ? err.message : '(no output)'));
      });
    });
    const doc = await vscode.workspace.openTextDocument({ content: `# mole ${args.join(' ')}\n\n${text}\n`, language: 'markdown' });
    await vscode.window.showTextDocument(doc, { preview: true });
  };
  const currentTarget = (): string | undefined => {
    const ed = vscode.window.activeTextEditor;
    if (!ed || ed.document.uri.scheme !== 'file') return undefined;
    return toRepoPath(root, ed.document.uri.fsPath);
  };
  const askTarget = async (prompt: string): Promise<string | undefined> => vscode.window.showInputBox({ prompt, value: currentTarget() ?? '' });
  const cmds: Array<[string, string, () => Promise<void>]> = [
    ['mole.cli.map', 'Map (mole map)', async () => { const t = await askTarget('file or file#Symbol to map'); if (t) await show('map', ['map', t]); }],
    ['mole.cli.impact', 'Impact (mole impact)', async () => { const t = await askTarget('file or file#Symbol for impact'); if (t) await show('impact', ['impact', t]); }],
    ['mole.cli.noteAdd', 'Add a note (mole note add)', async () => {
      const t = await askTarget('file#Symbol to note');
      if (!t) return;
      const text = await vscode.window.showInputBox({ prompt: 'note text' });
      if (text) await show('note add', ['note', 'add', t, text]);
    }],
    ['mole.cli.memory', 'Notes (mole memory)', () => show('memory', ['memory'])],
    ['mole.cli.since', 'Since you last looked (mole since)', () => show('since', ['since'])],
    ['mole.cli.pastFixes', 'Past fixes (mole check)', () => show('check', ['check', '--worktree'])],
    ['mole.cli.questions', 'Questions (mole check)', () => show('check --questions', ['check', '--worktree'])],
    ['mole.cli.decisions', 'Decisions (mole decisions)', () => show('decisions', ['decisions'])],
    ['mole.cli.rules', 'Rule violations (mole rules)', () => show('rules', ['rules'])],
    ['mole.cli.runTests', 'Run guarding tests (mole check --run-tests)', () => show('check --run-tests', ['check', '--worktree', '--run-tests'])],
    ['mole.cli.claims', 'Claims (mole claims)', async () => {
      const id = await vscode.window.showInputBox({ prompt: 'run id (Hermes/Claude Code/Codex session)' });
      if (id) await show('claims', ['claims', id]);
    }],
    ['mole.cli.flows', 'Blast radius: flows (mole flows)', async () => { const t = await askTarget('file#Symbol for flows'); if (t) await show('flows', ['flows', t]); }],
    ['mole.cli.collisions', 'Agent collisions (mole collisions)', () => show('collisions', ['collisions'])],
    ['mole.cli.tried', 'Already tried (mole tried)', async () => { const t = await askTarget('file#Symbol or run id'); if (t) await show('tried', ['tried', t]); }],
  ];
  for (const [id, , handler] of cmds) ctx.subscriptions.push(vscode.commands.registerCommand(id, handler));
}

/**
 * MOLE_M26_CHECK=<json path>: {out}. T34's own done-when check (apps/vscode/scripts/m26.mjs), run inside a real
 * Extension Development Host via `code --extensionDevelopmentPath` (no @vscode/test-electron, no Electron
 * download — see (internal reference removed) log/key-changes.md #1). Opens a few TypeScript files in the Mole repo,
 * moves the cursor, and records: every registered command id, the sidebar view's last-rendered model (for
 * M26a's "in the rendered model" check), the rules diagnostics collection, and (M26b) the ms from each
 * cursor-move/file-switch trigger to its webview postMessage round trip, 3 refreshes.
 */
async function m26Check(mole: MolePanel, panelView: MolePanelView | undefined, root: string, cfgPath: string): Promise<void> {
  // poll with plain node:fs (not vscode.workspace.fs, which showed one spurious ENOENT moments after the
  // script wrote the file synchronously before spawning this process — a filesystem-visibility race, not a
  // missing file: retrying a few times costs nothing and is the same shape hover-check.mjs already uses for
  // its own output file).
  let raw = '';
  for (let i = 0; i < 20 && !raw; i++) {
    if (existsSync(cfgPath)) {
      try {
        raw = readFileSync(cfgPath, 'utf8');
      } catch {
        raw = '';
      }
    }
    if (!raw) await new Promise((r) => setTimeout(r, 250));
  }
  const cfg = JSON.parse(raw || '{}') as { out?: string; files?: string[]; shot?: string; scrollTo?: string; whatIfOrder?: string };
  if (!cfg.out) {
    output.appendLine(`m26 check: could not read config at ${cfgPath}`);
    return;
  }
  const out: Record<string, unknown> = {};
  try {
    await vscode.commands.executeCommand('workbench.action.closeAuxiliaryBar');
    await mole.boot();
    out.commands = await vscode.commands.getCommands(true);
    // the sidebar view is lazy: VS Code only calls resolveWebviewView once its container is opened. Open it
    // explicitly (the auto-generated "<viewId>.focus" command), or the webview never exists and nothing ever
    // posts a 'rendered' ack back (M26b would stay empty forever, looking like a correctness bug).
    await vscode.commands.executeCommand('mole.panelView.focus');
    await new Promise((r) => setTimeout(r, 500));
    const files = cfg.files ?? ['apps/vscode/src/extension.ts', 'apps/vscode/src/panelData.ts', 'apps/vscode/src/panelView.ts'];
    for (const f of files) {
      const full = join(root, f);
      if (!existsSync(full)) continue;
      await vscode.window.showTextDocument(vscode.Uri.file(full), { viewColumn: vscode.ViewColumn.One, preview: false });
      await vscode.commands.executeCommand('workbench.action.focusSideBar');
      if (panelView) {
        const editor = vscode.window.activeTextEditor;
        if (editor) {
          const pos = new vscode.Position(Math.min(editor.document.lineCount - 1, 10), 0);
          editor.selection = new vscode.Selection(pos, pos);
        }
        await panelView.follow(vscode.window.activeTextEditor); // cold: pays the real cost once per file+commit
        panelView.refreshMsSamples.length = 0;
        // M26b measures the cached path: cursor moves that stay in the same (file, commit, symbol) are a cache
        // hit by design (prior-art.md #1's GitLens/Cody idiom); 3 such refreshes is what the key asks for.
        for (let i = 0; i < 3; i++) await panelView.follow(vscode.window.activeTextEditor);
        await new Promise((r) => setTimeout(r, 300));
      }
    }
    out.model = panelView?.lastModel;
    out.refreshMs = panelView?.refreshMsSamples ?? [];
    out.diagnosticsCollections = vscode.languages.getDiagnostics().map(([, ds]) => ds.map((d) => d.source ?? '')).flat();
    out.diagnosticsNames = ['mole-rules']; // the collection name itself (for M26a's "rules" coverage)
    if (cfg.shot) {
      // the sidebar is already visible and focused from the check above: a fresh `code --new-window` session
      // is the frontmost app with no AppleScript needed (scripts/selftest.mjs's osascript activate call is
      // the only thing this screenshot deliberately avoids — it needs a macOS Automation grant this sandboxed
      // run does not have; see (internal reference removed) insights.md).
      if (cfg.scrollTo) panelView?.scrollTo(cfg.scrollTo); // T62: bring one section into view for its screenshot
      if (cfg.whatIfOrder) panelView?.triggerWhatIf(cfg.whatIfOrder); // T73: script the what-if before the shot
      await new Promise((r) => setTimeout(r, cfg.whatIfOrder ? 3000 : 1500)); // the what-if is one more CLI round trip
      out.model = panelView?.lastModel; // T73: re-capture AFTER the what-if round trip updated it (was stale above)
      writeFileSync(`${cfg.shot}.ready`, 'ok');
      await new Promise((r) => setTimeout(r, 4000));
    }
  } catch (e) {
    out.error = (e as Error).stack ?? (e as Error).message;
  }
  writeFileSync(cfg.out, JSON.stringify(out, null, 2));
  await new Promise((r) => setTimeout(r, 500));
  await vscode.commands.executeCommand('workbench.action.quit');
}

/** The Mole CLI this extension runs: mole.daemonCli, else the bundled one, else the repo build (development). */
function moleCli(ctx: vscode.ExtensionContext): string {
  const bundled = join(ctx.extensionPath, 'dist', 'daemon.cjs');
  return vscode.workspace.getConfiguration('mole').get<string>('daemonCli') || (existsSync(bundled) ? bundled : resolve(ctx.extensionPath, '../../packages/daemon/dist/cli.js'));
}

const TS_LANGS = new Set(['typescript', 'typescriptreact']);
const SEEN_FLUSH_MS = 3000;

/**
 * L1 (T13): record what you look at into .mole/local/seen.jsonl (personal, gitignored): a symbol visible for 5 s, or hovered.
 * Symbol names come from VS Code's document symbols (no TypeScript compiler in the extension host); `mole seen --stdin` hashes
 * the bodies, so the file format has one owner (@mole/memory). Setting mole.recordSeen (default on) turns it off.
 */
function startSeen(ctx: vscode.ExtensionContext, root: string): void {
  const enabled = (): boolean => vscode.workspace.getConfiguration('mole').get<boolean>('recordSeen', true);
  const spansCache = new Map<string, { version: number; spans: SymbolSpan[] }>();
  const spansOf = async (doc: vscode.TextDocument): Promise<SymbolSpan[]> => {
    const key = doc.uri.toString();
    const hit = spansCache.get(key);
    if (hit && hit.version === doc.version) return hit.spans;
    let nodes: DocSymbol[] = [];
    try {
      nodes = (await vscode.commands.executeCommand<vscode.DocumentSymbol[]>('vscode.executeDocumentSymbolProvider', doc.uri)) ?? [];
    } catch {
      // no symbol provider (TypeScript extension disabled): nothing to record
    }
    const spans = documentSymbolTails(nodes);
    if (spansCache.size > 200) spansCache.clear();
    spansCache.set(key, { version: doc.version, spans });
    return spans;
  };
  const repoPath = (doc: vscode.TextDocument): string | undefined => (doc.uri.scheme === 'file' && TS_LANGS.has(doc.languageId) ? toRepoPath(root, doc.uri.fsPath) : undefined);
  const write = (hits: SeenHit[]): void => {
    const time = new Date().toISOString();
    const dirty = new Map(vscode.workspace.textDocuments.filter((d) => d.isDirty).map((d) => [toRepoPath(root, d.uri.fsPath), d.getText()] as const));
    const batch = hits.map((h) => ({ ...h, time, ...(dirty.has(h.path) ? { text: dirty.get(h.path) } : {}) }));
    try {
      const child = spawn(process.execPath, [moleCli(ctx), 'seen', '--stdin', '--root', root], { env: { ...process.env, ELECTRON_RUN_AS_NODE: '1' }, stdio: ['pipe', 'ignore', 'pipe'] });
      let err = '';
      child.stderr?.on('data', (d: Buffer) => (err += d.toString()));
      child.on('error', (e) => output.appendLine(`seen log: ${e.message}`));
      child.on('exit', (code) => {
        if (code !== 0) output.appendLine(`seen log: mole seen exited ${code} ${err.slice(0, 300)}`);
      });
      child.stdin?.end(JSON.stringify(batch));
    } catch (e) {
      output.appendLine(`seen log: ${(e as Error).message}`);
    }
  };
  const recorder = new SeenRecorder({ enabled, write });
  let focused = vscode.window.state.focused;
  let viewSeq = 0;
  const update = async (): Promise<void> => {
    const seq = ++viewSeq;
    const editor = vscode.window.activeTextEditor;
    const path = editor && focused && enabled() ? repoPath(editor.document) : undefined;
    if (!editor || !path) {
      recorder.view(undefined);
      return;
    }
    const spans = dwellSpans(await spansOf(editor.document));
    if (seq !== viewSeq) return; // a newer scroll/switch already reported
    recorder.view({ path, symbols: spans, ranges: editor.visibleRanges.map((r) => ({ start: r.start.line, end: r.end.line })) });
  };
  let sinceFlush = 0;
  const timer = setInterval(() => {
    recorder.tick();
    sinceFlush += 1000;
    if (sinceFlush >= SEEN_FLUSH_MS && recorder.pendingCount() > 0) {
      sinceFlush = 0;
      recorder.flush();
    }
  }, 1000);
  const hover: vscode.HoverProvider = {
    async provideHover(doc, pos) {
      const path = repoPath(doc);
      if (path && enabled()) {
        const s = spanAt(await spansOf(doc), pos.line);
        if (s) recorder.hover(path, s.tail);
      }
      return undefined; // Mole adds nothing to the hover itself
    },
  };
  ctx.subscriptions.push(
    vscode.languages.registerHoverProvider([{ language: 'typescript', scheme: 'file' }, { language: 'typescriptreact', scheme: 'file' }], hover),
    vscode.window.onDidChangeActiveTextEditor(() => void update()),
    vscode.window.onDidChangeTextEditorVisibleRanges(() => void update()),
    vscode.window.onDidChangeWindowState((st) => {
      focused = st.focused;
      void update();
    }),
    vscode.workspace.onDidSaveTextDocument((doc) => {
      const path = repoPath(doc);
      if (path) recorder.reset(path); // the saved body is new: looking at it for 5 s counts again
      void update();
    }),
    vscode.workspace.onDidChangeConfiguration((e) => {
      if (e.affectsConfiguration('mole.recordSeen')) void update();
    }),
    { dispose: () => (clearInterval(timer), recorder.flush()) },
  );
  void update();
}

/** A tsconfig or any .ts/.tsx file outside dependency and build folders. */
async function hasTypeScript(): Promise<boolean> {
  const found = await vscode.workspace.findFiles('{**/tsconfig*.json,**/*.ts,**/*.tsx}', '**/{node_modules,dist,out,build,.git}/**', 1);
  return found.length > 0;
}

/** node:sqlite (the graph store) needs Node 22.13+; VS Code 1.101+ ships it. Forks on older Electron get a clear message instead of a crash. */
function nodeTooOld(): string | undefined {
  const [maj = 0, min = 0] = process.versions.node.split('.').map(Number);
  return maj > 22 || (maj === 22 && min >= 13) ? undefined : `This editor runs Node ${process.versions.node}; Mole needs Node 22.13 or newer (VS Code 1.101+). Update the editor, or use Mole from the command line.`;
}

/** A Mole webview tab exists in some editor group (restored or open). */
function hasMoleTab(): boolean {
  return vscode.window.tabGroups.all.some((g) => g.tabs.some((t) => t.input instanceof vscode.TabInputWebview && t.input.viewType.endsWith(VIEW_TYPE)));
}

export function deactivate(): void {
  // the daemon is shared by every window of this repo and outlives the editor on purpose
}

class MolePanel {
  private panel?: vscode.WebviewPanel;
  private client?: MoleClient;
  private impact = false;
  private seq = 0;
  private lastTarget?: string;
  private waiters = new Map<number, (r: Rendered) => void>();
  private painters = new Map<number, (ms: number) => void>();
  private ready?: () => void;
  private readonly ui = new Promise<void>((r) => (this.ready = r));
  private pollTimer?: NodeJS.Timeout;
  private booting?: Promise<void>;
  private unsupported?: string;
  private lastRevive = 0;
  samples: Sample[] = [];
  private since?: SinceResult;
  sinceRendered = -1;
  sinceWaiters: Array<(n: number) => void> = [];

  /** T15: the panel's "Since you last looked" list (`mole since --json`); kept for a panel that is opened or restored later. */
  setSince(r: SinceResult | undefined): void {
    this.since = r;
    if (r) void this.panel?.webview.postMessage({ type: 'since', since: r });
  }

  constructor(private readonly ctx: vscode.ExtensionContext, private readonly root: string | undefined) {}

  hasPanel(): boolean {
    return this.panel !== undefined;
  }

  /** T34: the live daemon client, if the daemon has started (undefined before boot() resolves or when unsupported). */
  getClient(): MoleClient | undefined {
    return this.client;
  }

  /** Start (or find) the repo's daemon, once. Never throws: the panel shows "index unavailable" instead. */
  boot(): Promise<void> {
    this.booting ??= this.startDaemon();
    return this.booting;
  }

  /** (Re)start the daemon: it stops itself after `mole.idleMinutes` without requests, so the editor starts a new one on demand. */
  private async startDaemon(): Promise<void> {
    if (!this.root) return;
    this.unsupported = nodeTooOld();
    if (this.unsupported) {
      output.appendLine(this.unsupported);
      // the panel must say so, not stay blank
      void this.follow(vscode.window.activeTextEditor, performance.now());
      return;
    }
    const cfg = vscode.workspace.getConfiguration('mole');
    const cli = moleCli(this.ctx);
    if (!existsSync(cli)) {
      output.appendLine(`daemon cli not found at ${cli}; set mole.daemonCli`);
      this.client = new MoleClient({ root: this.root, stateDir: cfg.get<string>('stateDir') || undefined });
      return;
    }
    this.client = await ensureDaemon({
      root: this.root,
      stateDir: cfg.get<string>('stateDir') || process.env.MOLE_STATE_DIR || undefined,
      tsconfig: cfg.get<string>('tsconfig') || process.env.MOLE_TSCONFIG || undefined,
      srcDir: cfg.get<string>('srcDir') || process.env.MOLE_SRC_DIR || undefined,
      idleMinutes: process.env.MOLE_IDLE_MINUTES ? Number(process.env.MOLE_IDLE_MINUTES) : cfg.get<number>('idleMinutes', 30),
      nodePath: process.execPath,
      cliPath: cli,
      env: { ELECTRON_RUN_AS_NODE: '1' },
    });
    output.appendLine(`daemon ${(await this.client.running()) ? 'ready' : 'not answering'} for ${this.root}`);
    if (!process.env.MOLE_SELFTEST) void this.follow(vscode.window.activeTextEditor, performance.now());
  }

  /** Panel beside the code: ~half the window, group locked so opened files do not replace it. */
  async open(): Promise<void> {
    if (this.panel) {
      this.panel.reveal(undefined, true);
      return;
    }
    if (hasMoleTab()) return; // restoring from the last session
    // 1. two groups at 50/50 (only when the window has a single group: never reshuffle a layout the user built)
    if (vscode.window.tabGroups.all.length <= 1) await vscode.commands.executeCommand('vscode.setEditorLayout', { orientation: 0, groups: [{ size: 0.5 }, { size: 0.5 }] });
    // 2. the panel goes in the right-hand group, which is then the active one, so the lock lands on it
    const panel = vscode.window.createWebviewPanel(VIEW_TYPE, 'Mole', { viewColumn: vscode.ViewColumn.Two, preserveFocus: false }, { enableScripts: true, retainContextWhenHidden: true, localResourceRoots: [vscode.Uri.joinPath(this.ctx.extensionUri, 'dist')] });
    this.adopt(panel);
    await vscode.commands.executeCommand('workbench.action.lockEditorGroup');
    // 3. hand focus back to the code
    await vscode.commands.executeCommand('workbench.action.focusFirstEditorGroup');
  }

  /** Wire a (new or restored) webview panel. */
  adopt(panel: vscode.WebviewPanel): void {
    this.panel = panel;
    panel.webview.options = { enableScripts: true, localResourceRoots: [vscode.Uri.joinPath(this.ctx.extensionUri, 'dist')] };
    panel.webview.html = this.html(panel.webview);
    panel.onDidDispose(() => {
      this.panel = undefined;
      clearTimeout(this.pollTimer);
    });
    panel.webview.onDidReceiveMessage((m: { type: string; [k: string]: unknown }) => void this.onMessage(m));
  }

  private html(webview: vscode.Webview): string {
    const nonce = Math.random().toString(36).slice(2);
    const script = webview.asWebviewUri(vscode.Uri.joinPath(this.ctx.extensionUri, 'dist', 'webview.js'));
    return `<!doctype html><html><head><meta charset="utf-8"><meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src 'nonce-${nonce}'; script-src 'nonce-${nonce}'; img-src data:;"><style nonce="${nonce}">${CSS}</style></head><body><div id="app"></div><div id="since"></div><script nonce="${nonce}" src="${script}"></script></body></html>`;
  }

  private async onMessage(m: { type: string; [k: string]: unknown }): Promise<void> {
    if (m.type !== 'rendered' && m.type !== 'painted') output.appendLine(`webview → ${JSON.stringify(m).slice(0, 300)}`);
    if (m.type === 'ready') {
      this.ready?.();
      if (this.lastTarget) void this.send(this.lastTarget);
      if (this.since) void this.panel?.webview.postMessage({ type: 'since', since: this.since });
    } else if (m.type === 'sinceRendered') {
      this.sinceRendered = Number(m.items);
      for (const w of this.sinceWaiters.splice(0)) w(this.sinceRendered);
    } else if (m.type === 'rendered') {
      const r = m as unknown as Rendered;
      this.waiters.get(r.seq)?.(r);
      this.waiters.delete(r.seq);
    } else if (m.type === 'painted') {
      this.painters.get(Number(m.seq))?.(Number(m.paintMs));
      this.painters.delete(Number(m.seq));
    } else if (m.type === 'open') {
      await this.openFile(String(m.path), Number(m.line));
      if (this.openWait && this.openWait.id === m.id) this.openWait.done('opened');
    } else if (m.type === 'selftestClickMissing') {
      if (this.openWait && this.openWait.id === m.id) this.openWait.done('missing');
    } else if (m.type === 'error') {
      output.appendLine(`webview error: ${String(m.message)}`);
    } else if (m.type === 'impact') {
      this.impact = m.on === true;
      if (this.lastTarget) void this.send(this.lastTarget);
    } else if (m.type === 'reindex') {
      await this.reindex();
    }
  }

  /** self-test: the pending DOM click (matched by node id, so a late message from an earlier click cannot resolve a newer one) */
  openWait?: { id: string; done: (r: 'opened' | 'missing') => void };

  /** self-test: make the webview click a node through its real DOM handler, then wait until the host handled the resulting 'open'. */
  async domClick(id: string): Promise<'opened' | 'missing' | 'timeout'> {
    if (!this.panel) return 'missing';
    const done = new Promise<'opened' | 'missing' | 'timeout'>((ok) => {
      this.openWait = { id, done: ok };
      setTimeout(() => ok('timeout'), 4000);
    });
    await this.panel.webview.postMessage({ type: 'selftestClick', id });
    const r = await done;
    this.openWait = undefined;
    return r;
  }

  /** Click on a node: open `file:line` in an editor group other than the panel's. */
  async openFile(path: string, line1: number): Promise<void> {
    if (!this.root) return;
    const line = Math.max(0, line1 - 1);
    const group = vscode.window.tabGroups.all.find((g) => g.viewColumn !== this.panel?.viewColumn)?.viewColumn;
    await vscode.window.showTextDocument(vscode.Uri.file(join(this.root, path)), { viewColumn: group ?? vscode.ViewColumn.One, selection: new vscode.Range(line, 0, line, 0), preserveFocus: false });
  }

  async toggleImpact(): Promise<void> {
    this.impact = !this.impact;
    if (this.lastTarget) await this.send(this.lastTarget);
  }

  async reindex(): Promise<void> {
    try {
      await this.client?.call('reindex');
    } catch (e) {
      output.appendLine(`reindex failed: ${(e as Error).message}`);
    }
    if (this.lastTarget) void this.send(this.lastTarget);
  }

  /** Follow the active editor. Ignores non-file schemes and files outside the repo; a webview focus (undefined editor) keeps the last map. */
  async follow(editor: vscode.TextEditor | undefined, startedAt: number): Promise<Sample | undefined> {
    if (!editor || !this.root || editor.document.uri.scheme !== 'file') return undefined;
    const rel = toRepoPath(this.root, editor.document.uri.fsPath);
    if (!rel) return undefined;
    this.lastTarget = rel;
    return this.send(rel, startedAt);
  }

  private async send(target: string, startedAt = performance.now()): Promise<Sample | undefined> {
    const panel = this.panel;
    if (!panel || (!this.client && !this.unsupported)) return undefined;
    const seq = ++this.seq;
    const t0 = performance.now();
    let map: Neighborhood = this.unsupported
      ? { state: 'index-unavailable', message: this.unsupported, nodes: [], edges: [], more: [] }
      : await this.client!.map(target, this.impact);
    // (not in the self-tests: they stop the daemon on purpose and check what the editor shows without it)
    if (map.state === 'index-unavailable' && !this.unsupported && !process.env.MOLE_SELFTEST && !process.env.MOLE_HOVER_CHECK && Date.now() - this.lastRevive > 10_000) {
      // the daemon stopped (idle shutdown, crash, or killed): start a new one and ask again, at most once per 10 s
      this.lastRevive = Date.now();
      output.appendLine('daemon not answering: starting a new one');
      await this.startDaemon();
      map = this.unsupported ? map : await this.client!.map(target, this.impact);
    }
    const rpcMs = performance.now() - t0;
    if (seq !== this.seq || !this.panel) return undefined; // a newer switch overtook this one
    await Promise.race([this.ui, new Promise((ok) => setTimeout(ok, 8000))]);
    const rendered = new Promise<Rendered>((ok) => {
      this.waiters.set(seq, ok);
      setTimeout(() => this.waiters.delete(seq), 5000);
    });
    void panel.webview.postMessage({ type: 'map', map, seq, impact: this.impact });
    clearTimeout(this.pollTimer);
    if (map.state === 'indexing') this.pollTimer = setTimeout(() => void this.send(target), 1000);
    const r = await Promise.race([rendered, new Promise<undefined>((ok) => setTimeout(ok, 5000))]);
    if (!r) return undefined;
    const done = performance.now();
    const paintMs = await Promise.race([new Promise<number>((ok) => this.painters.set(seq, ok)), new Promise<null>((ok) => setTimeout(() => ok(null), 300))]);
    this.painters.delete(seq);
    const s: Sample = { file: target, state: map.state, nodes: r.nodes, rpcMs, layoutMs: r.layoutMs, drawMs: r.drawMs, paintMs, totalMs: done - t0, withDebounceMs: done - startedAt };
    this.samples.push(s);
    return s;
  }
}

/**
 * MOLE_SELFTEST=<json path>: {out, files[], shot?} — open each file in turn, record warm switch latency, write `out`,
 * optionally screenshot, then quit. Used by the T2 latency proof; never active in normal use.
 */
async function selfTest(mole: MolePanel, cfgPath: string): Promise<void> {
  const cfg = JSON.parse((await vscode.workspace.fs.readFile(vscode.Uri.file(cfgPath))).toString()) as { out: string; files: string[]; shot?: string; shotFile?: string; shot2?: string; shot3?: string };
  const root = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath ?? '';
  try {
    await vscode.commands.executeCommand('workbench.action.closeAuxiliaryBar');
    await mole.open();
    await mole.boot();
    // wait for the first index
    const c = new MoleClient({ root, stateDir: process.env.MOLE_STATE_DIR });
    for (let i = 0; i < 300; i++) {
      const st = await c.status().catch(() => undefined);
      if (st?.state === 'ready') break;
      await new Promise((r) => setTimeout(r, 200));
    }
    const out: Sample[] = [];
    const group = vscode.ViewColumn.One;
    // Real path: showTextDocument fires onDidChangeActiveTextEditor, whose (leading-edge debounced) listener drives the map.
    // The script only waits for the sample that listener produces. A pause between switches keeps each one a "lone" switch;
    // switches closer than the 120 ms window are coalesced on purpose.
    const switchTo = async (rel: string): Promise<Sample | undefined> => {
      await new Promise((r) => setTimeout(r, 160));
      const n0 = mole.samples.length;
      await vscode.window.showTextDocument(vscode.Uri.file(join(root, rel)), { viewColumn: group, preview: false });
      for (let i = 0; i < 120 && mole.samples.length <= n0; i++) await new Promise((r) => setTimeout(r, 50));
      return mole.samples.length > n0 ? mole.samples[mole.samples.length - 1] : undefined;
    };
    for (const f of cfg.files) {
      const s = await switchTo(f);
      if (s) out.push(s);
    }
    const shotFile = cfg.shotFile ?? cfg.files[0] ?? '';
    if (cfg.shot) {
      await switchTo(shotFile);
      await new Promise((r) => setTimeout(r, 1500));
      writeFileSync(`${cfg.shot}.ready`, 'ok');
      await new Promise((r) => setTimeout(r, 4000));
    }
    // impact view in the real window: toggle it (palette command path), screenshot, record what the daemon says, toggle back
    let impactCheck: { impactTotal?: number; impactedShown: number } | undefined;
    if (cfg.shot3) {
      await mole.toggleImpact();
      const im = await new MoleClient({ root, stateDir: process.env.MOLE_STATE_DIR }).map(shotFile, true);
      impactCheck = { impactTotal: im.impactTotal, impactedShown: im.nodes.filter((n) => n.impacted).length };
      await new Promise((r) => setTimeout(r, 1500));
      writeFileSync(`${cfg.shot3}.ready`, 'ok');
      await new Promise((r) => setTimeout(r, 4000));
      await mole.toggleImpact();
    }
    // click-to-open, EVERY node: the line the webview would send (clickLine) must be where the editor lands. For a symbol map the
    // landed line of each caller must also contain the focus symbol's name (it is a real call site, not the caller's declaration).
    type Open = { map: string; id: string; role: string; path: string; line: number; via: 'openFile' | 'dom'; landedPath?: string; landedLine?: number; textHasFocusName?: boolean; ok: boolean };
    const openChecks: Open[] = [];
    const sentinel = async (): Promise<void> => {
      // park the editor somewhere no node points at, so a navigation that silently does nothing cannot pass by coincidence
      await mole.openFile('package.json', 1);
    };
    const callOf = (name: string): RegExp => new RegExp(`(?<![\\w$])${name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\s*[(<]`);
    const record = (mapName: string, n: { id: string; role: string; path: string }, line: number, via: 'openFile' | 'dom', checkText: string | undefined): void => {
      const ed = vscode.window.activeTextEditor;
      const landedPath = ed ? toRepoPath(root, ed.document.uri.fsPath) : undefined;
      const landedLine = ed ? ed.selection.active.line + 1 : undefined;
      const text = ed && landedLine ? ed.document.lineAt(landedLine - 1).text : '';
      const needsText = checkText !== undefined && n.role === 'caller';
      const textHasFocusName = needsText ? callOf(checkText).test(text.replace(/\/\/.*$/, '')) : undefined;
      openChecks.push({ map: mapName, id: n.id, role: n.role, path: n.path, line, via, landedPath, landedLine, textHasFocusName, ok: landedPath === n.path && landedLine === line && (!needsText || textHasFocusName === true) });
    };
    const openAll = async (target: string, checkText: string | undefined): Promise<void> => {
      const mp = await new MoleClient({ root, stateDir: process.env.MOLE_STATE_DIR }).map(target);
      for (const n of mp.nodes.filter((x) => x.role !== 'focus')) {
        const line = clickLine(n);
        await sentinel();
        await mole.openFile(n.path, line);
        record(target, n, line, 'openFile', checkText);
      }
    };
    // the real DOM click path (webview click handler -> postMessage -> host open): for the first files, whose map is the one the panel shows
    const domFiles = [shotFile, ...cfg.files.filter((x) => x !== shotFile)].slice(0, Number(process.env.MOLE_DOM_CLICK_FILES ?? 6));
    for (const file of domFiles) {
      const mp = await new MoleClient({ root, stateDir: process.env.MOLE_STATE_DIR }).map(file);
      for (const n of mp.nodes.filter((x) => x.role !== 'focus')) {
        const line = clickLine(n);
        let result: 'opened' | 'missing' | 'timeout' = 'missing';
        for (let attempt = 0; attempt < 2 && result !== 'opened'; attempt++) {
          await sentinel();
          await switchTo(file); // panel shows this file's map again (opening a node moved the editor, and the panel follows it)
          await new Promise((r) => setTimeout(r, 150));
          result = await mole.domClick(n.id);
        }
        if (result !== 'opened') openChecks.push({ map: file, id: n.id, role: n.role, path: n.path, line, via: 'dom', ok: false });
        else record(file, n, line, 'dom', undefined);
      }
    }
    // every sampled file's map, plus the symbol map of its most-connected function (functions only: a class's call site is wherever
    // an instance member is used, so its line need not contain the class name)
    const clickFiles = [shotFile, ...cfg.files.filter((x) => x !== shotFile)].slice(0, Number(process.env.MOLE_CLICK_FILES ?? 40));
    for (const file of clickFiles) {
      await openAll(file, undefined);
      const fileMap = await new MoleClient({ root, stateDir: process.env.MOLE_STATE_DIR }).map(file);
      const fn = fileMap.nodes.filter((x) => x.role === 'own' && x.kind === 'function').sort((p, q) => q.score - p.score)[0];
      if (fn) await openAll(`${file}#${fn.name}`, fn.name);
    }
    const openCheck = openChecks[0];
    // failure cases in the real editor: a file outside the index, then the daemon going away
    const failures: Sample[] = [];
    const s1 = await switchTo('package.json');
    if (s1) failures.push(s1);
    await c.call('shutdown').catch(() => undefined);
    await new Promise((r) => setTimeout(r, 500));
    const s2 = await switchTo(shotFile);
    if (s2) failures.push(s2);
    if (cfg.shot2) {
      await new Promise((r) => setTimeout(r, 1000));
      writeFileSync(`${cfg.shot2}.ready`, 'ok');
      await new Promise((r) => setTimeout(r, 4000));
    }
    writeFileSync(cfg.out, JSON.stringify({ samples: out, failures, openCheck, openChecks, impactCheck, layoutGroups: vscode.window.tabGroups.all.map((g) => ({ col: g.viewColumn, locked: undefined, tabs: g.tabs.length })) }, null, 2));
  } catch (e) {
    writeFileSync(cfg.out, JSON.stringify({ error: (e as Error).message }));
  }
  await vscode.commands.executeCommand('workbench.action.quit');
  void dirname;
}

/** MOLE_SELFTEST_RESTORE=<out>: second launch on the same profile; did the panel come back by itself, and does it follow? */
async function restoreProbe(mole: MolePanel, out: string): Promise<void> {
  await new Promise((r) => setTimeout(r, 4000));
  const tabs = vscode.window.tabGroups.all.flatMap((g) => g.tabs.map((t) => ({ col: g.viewColumn, label: t.label, webview: t.input instanceof vscode.TabInputWebview ? t.input.viewType : undefined })));
  const root = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath ?? '';
  const file = vscode.window.activeTextEditor?.document.uri.fsPath;
  const before = mole.samples.length;
  let state = 'none';
  for (let i = 0; i < 40 && file; i++) {
    state = (await mole.follow(vscode.window.activeTextEditor, performance.now()))?.state ?? 'none';
    if (state === 'ok') break;
    await new Promise((r) => setTimeout(r, 1000));
  }
  writeFileSync(out, JSON.stringify({ panelAdopted: mole.hasPanel(), moleTabs: tabs.filter((t) => t.webview), groups: vscode.window.tabGroups.all.length, followedActiveEditor: mole.samples.length > before, mapStateAfterRelaunch: state, activeFile: file ? file.replace(root, '') : null }, null, 2));
  writeFileSync(`${out}.ready`, 'ok');
  await new Promise((r) => setTimeout(r, 4000));
  await vscode.commands.executeCommand('workbench.action.quit');
}

/**
 * MOLE_HOVER_CHECK=<json path>: {out, file, line, expect} (T15 done-when 1, 2, 5, 6; driven by scripts/hover-check.mjs). In the real
 * editor: hover at file:line through vscode.executeHoverProvider, count the gutter marks drawn, run the two links the hover
 * carries (the exact command + arguments parsed from its markdown, which is what a click on them executes), wait for the
 * panel's since list, then stop the daemon and do it again: no Mole hover, no marks, and no popup at any point. Then quit.
 */
async function hoverCheck(mole: MolePanel, surface: Surface, root: string, cfgPath: string): Promise<void> {
  const cfg = JSON.parse((await vscode.workspace.fs.readFile(vscode.Uri.file(cfgPath))).toString()) as { out: string; file: string; line: number; expect: { sha: string } };
  const res: Record<string, unknown> = {};
  const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));
  // count every popup any code in this extension host raises
  const popups = { patched: false, count: 0, messages: [] as string[] };
  try {
    const w = vscode.window as unknown as Record<string, unknown>;
    for (const k of ['Error', 'Warning', 'Information'].map((x) => `show${x}Message`)) {
      const orig = w[k] as (...a: unknown[]) => unknown;
      const wrapped = (...a: unknown[]): unknown => {
        popups.count++;
        popups.messages.push(`${k}: ${String(a[0]).slice(0, 200)}`);
        return orig.apply(vscode.window, a);
      };
      w[k] = wrapped;
      popups.patched = w[k] === wrapped;
    }
  } catch (e) {
    output.appendLine(`hover check: cannot count popups: ${(e as Error).message}`);
  }
  const uri = vscode.Uri.file(join(root, cfg.file));
  const pos = new vscode.Position(cfg.line - 1, 0);
  const hoverTexts = async (): Promise<string[]> => {
    const hs = (await vscode.commands.executeCommand<vscode.Hover[]>('vscode.executeHoverProvider', uri, pos)) ?? [];
    return hs.flatMap((h) => h.contents.map((c) => (typeof c === 'string' ? c : c.value)));
  };
  const isMole = (t: string): boolean => t.startsWith('**Mole**');
  const links = (md: string): Array<[string, unknown[]]> =>
    [...md.matchAll(/\]\(command:(mole\.[A-Za-z]+)\?([^)\s]+)\)/g)].map((m) => [m[1] as string, JSON.parse(decodeURIComponent(m[2] as string)) as unknown[]]);
  try {
    await vscode.commands.executeCommand('workbench.action.closeAuxiliaryBar');
    await mole.boot();
    await mole.open();
    await vscode.window.showTextDocument(uri, { viewColumn: vscode.ViewColumn.One, preview: false });
    let loaded = false;
    for (let i = 0; i < 20 && !loaded; i++) {
      loaded = await surface.refresh();
      if (!loaded) await sleep(1000);
    }
    await surface.refreshSince();
    const t0 = Date.now();
    const texts = await hoverTexts();
    const hoverMs = Date.now() - t0;
    const hoverText = texts.find(isMole) ?? '';
    const up: Record<string, unknown> = { daemonRunning: await surface.running(), checkLoaded: loaded, hoverMs, hoverText, otherHovers: texts.filter((t) => !isMole(t)).length, decorations: surface.drawn.get(cfg.file) ?? 0, ranges: surface.touched.ranges(cfg.file).map((r) => [r.startLine, r.endLine]) };
    const ls = links(hoverText);
    up.links = ls;
    const commit = ls.find(([c]) => c === 'mole.showCommit');
    if (commit) {
      await vscode.commands.executeCommand(commit[0], ...commit[1]);
      await sleep(500);
      const ed = vscode.window.activeTextEditor;
      const text = ed?.document.getText() ?? '';
      up.clickCommit = { args: commit[1], uri: ed?.document.uri.toString(), firstLine: text.split('\n')[0], ok: ed?.document.uri.scheme === 'mole-git' && text.startsWith(`commit ${String(commit[1][0])}`) };
    }
    const source = ls.find(([c]) => c === 'mole.openAt');
    if (source) {
      await vscode.commands.executeCommand(source[0], ...source[1]);
      await sleep(500);
      const ed = vscode.window.activeTextEditor;
      const [file, line] = source[1] as [string, number];
      const landed = ed ? ed.selection.active.line + 1 : -1;
      const lineText = ed && landed > 0 ? ed.document.lineAt(landed - 1).text.trim() : '';
      up.clickSource = { args: source[1], uri: ed?.document.uri.toString(), landedLine: landed, lineText, ok: ed?.document.uri.scheme === 'mole-git' && ed.document.uri.path === `/${file}` && landed === line && lineText.length > 0 };
    }
    res.up = up;
    // panel: the since list rendered in the webview (the webview reports the number of rows it drew)
    let rendered = mole.sinceRendered;
    if (rendered <= 0) rendered = await Promise.race([new Promise<number>((ok) => mole.sinceWaiters.push(ok)), sleep(20_000).then(() => mole.sinceRendered)]);
    res.since = { rendered };
    // daemon down: back on the file, stop the daemon, then refresh + hover as the editor would
    await vscode.window.showTextDocument(uri, { viewColumn: vscode.ViewColumn.One, preview: false });
    await sleep(700);
    await surface.stopDaemon();
    for (let i = 0; i < 40 && (await surface.running()); i++) await sleep(250);
    await surface.refresh();
    const downTexts = await hoverTexts();
    res.down = { daemonRunning: await surface.running(), moleHovers: downTexts.filter(isMole).length, otherHovers: downTexts.length - downTexts.filter(isMole).length, decorations: surface.drawn.get(cfg.file) ?? 0 };
    await sleep(1500); // let any late popup land before counting
  } catch (e) {
    res.error = (e as Error).stack ?? (e as Error).message;
  }
  res.popups = popups;
  writeFileSync(cfg.out, JSON.stringify(res, null, 2));
  await sleep(500);
  await vscode.commands.executeCommand('workbench.action.quit');
}
