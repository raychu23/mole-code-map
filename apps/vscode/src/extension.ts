import { existsSync, readdirSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import * as vscode from 'vscode';
import type { Neighborhood } from '@mole/core';
import { ensureDaemon, MoleClient } from '@mole/daemon';
import { clickLine } from '../webview/render.js';
import { CSS } from '../webview/style.js';
import { debounce, toRepoPath } from './paths.js';

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
  if (!root) {
    output.appendLine('no workspace folder: Mole is idle');
    return;
  }
  const testing = Boolean(process.env.MOLE_SELFTEST || process.env.MOLE_SELFTEST_RESTORE);
  // a public extension must be silent where it has nothing to say: no TypeScript here = no panel, no background process
  const dormant = !testing && !(await hasTypeScript());
  if (process.env.MOLE_IDLE_PROBE) {
    setTimeout(() => writeFileSync(String(process.env.MOLE_IDLE_PROBE), JSON.stringify({ dormant, panel: mole.hasPanel() || hasMoleTab() })), 6000);
  }
  if (dormant) {
    output.appendLine('no TypeScript found in this workspace: Mole stays idle (run "Mole: Open map beside the code" to start it anyway)');
    return;
  }
  void mole.boot();
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

  constructor(private readonly ctx: vscode.ExtensionContext, private readonly root: string | undefined) {}

  hasPanel(): boolean {
    return this.panel !== undefined;
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
    const bundled = join(this.ctx.extensionPath, 'dist', 'daemon.cjs');
    const cli = cfg.get<string>('daemonCli') || (existsSync(bundled) ? bundled : resolve(this.ctx.extensionPath, '../../packages/daemon/dist/cli.js'));
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
    return `<!doctype html><html><head><meta charset="utf-8"><meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src 'nonce-${nonce}'; script-src 'nonce-${nonce}'; img-src data:;"><style nonce="${nonce}">${CSS}</style></head><body><div id="app"></div><script nonce="${nonce}" src="${script}"></script></body></html>`;
  }

  private async onMessage(m: { type: string; [k: string]: unknown }): Promise<void> {
    if (m.type !== 'rendered' && m.type !== 'painted') output.appendLine(`webview → ${JSON.stringify(m).slice(0, 300)}`);
    if (m.type === 'ready') {
      this.ready?.();
      if (this.lastTarget) void this.send(this.lastTarget);
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
    if (map.state === 'index-unavailable' && !this.unsupported && !process.env.MOLE_SELFTEST && Date.now() - this.lastRevive > 10_000) {
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
