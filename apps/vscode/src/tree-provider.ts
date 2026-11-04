// T30: registers the decision tree (src/tree.ts) as the Explorer's FileDecorationProvider: badge = decisions in force on a
// file/folder or below, color = the worst flag, tooltip = the folder's intent card. Only active when the workspace has .mole/.
// Flags come from `mole decisions --json` (the bundled CLI, a child process: git + the TypeScript compiler stay out of the
// extension host); records and the tree index from @mole/decisions' core, which needs neither. Computed once and cached; a change
// under .mole/ or a saved file recomputes them (debounced).
import { execFile } from 'node:child_process';
import { existsSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import * as vscode from 'vscode';
import type { DecisionsResult } from '@mole/decisions';
import { FolderTree } from './tree.js';

const REFRESH_MS = 1500;

/** `mole decisions --json --root <root>` with the given CLI, run by the editor's own Node. */
function flagsFromCli(cli: string, root: string): Promise<DecisionsResult> {
  return new Promise((resolve, reject) => {
    execFile(process.execPath, [cli, 'decisions', '--json', '--root', root], { env: { ...process.env, ELECTRON_RUN_AS_NODE: '1' }, maxBuffer: 64 * 1024 * 1024, timeout: 60_000 }, (err, stdout) => {
      if (err) return reject(new Error(`mole decisions: ${err.message.split('\n')[0]}`));
      try {
        resolve(JSON.parse(stdout) as DecisionsResult);
      } catch (e) {
        reject(new Error(`mole decisions: not JSON (${(e as Error).message})`));
      }
    });
  });
}

export function startDecisionTree(ctx: vscode.ExtensionContext, root: string, log: (m: string) => void, cli: string): void {
  if (!existsSync(join(root, '.mole'))) return;
  try {
    register(ctx, root, log, cli);
  } catch (e) {
    log(`decision tree: not started (${(e as Error).message})`); // never blocks the rest of activation
  }
}

/**
 * MOLE_TREE_CHECK=<json path>: proof artifact for T30 (no new Electron/Chromium download needed for a screenshot). After the
 * first refresh, dump every decorated folder's {badge, color, tooltip (intent card text)} plus one no-record folder (done-when
 * 4: must decorate to undefined) straight from the registered FileDecorationProvider — not re-derived, the same function the
 * Explorer calls. Used by scripts/tree-check.mjs.
 */
function treeCheck(tree: FolderTree, root: string, provider: vscode.FileDecorationProvider, outPath: string): void {
  const timer = setInterval(() => {
    const folders = tree.folders;
    if (folders === undefined) return; // refresh() not finished yet
    clearInterval(timer);
    const sample = folders.filter((f) => f !== '').slice(0, 12);
    const decorations = sample.map((f) => {
      const uri = vscode.Uri.file(join(root, f));
      const d = provider.provideFileDecoration!(uri, new vscode.CancellationTokenSource().token);
      const out = d as vscode.FileDecoration | undefined;
      return { path: f, badge: out?.badge, tooltip: out?.tooltip, color: (out?.color as vscode.ThemeColor | undefined)?.id };
    });
    const noRecordCandidates = ['generated data', 'node_modules', '.git'];
    const noRecord = noRecordCandidates
      .filter((p) => existsSync(join(root, p)))
      .map((p) => ({ path: p, decoration: provider.provideFileDecoration!(vscode.Uri.file(join(root, p)), new vscode.CancellationTokenSource().token) }));
    writeFileSync(
      outPath,
      JSON.stringify(
        {
          generatedAt: new Date().toISOString(),
          what: 'T30: every decorated folder (badge/color/tooltip=intent card) from the live FileDecorationProvider, plus a no-record folder (done-when 4: must be undefined)',
          folderCount: folders.length,
          decorations,
          noRecord,
        },
        null,
        2,
      ) + '\n',
    );
  }, 300);
}

function register(ctx: vscode.ExtensionContext, root: string, log: (m: string) => void, cli: string): void {
  const tree = new FolderTree(
    root,
    async (r) => {
      const [{ loadTreeFrom }, flags] = await Promise.all([import('@mole/decisions/dist/src/tree/core.js'), flagsFromCli(cli, r)]);
      return loadTreeFrom(r, flags.decisions);
    },
    (e) => log(`decision tree: ${e.message}`),
  );
  const changed = new vscode.EventEmitter<undefined>();
  const provider: vscode.FileDecorationProvider = {
    onDidChangeFileDecorations: changed.event,
    provideFileDecoration(uri) {
      if (uri.scheme !== 'file') return undefined;
      const d = tree.decorate(uri.fsPath);
      if (!d) return undefined;
      const out = new vscode.FileDecoration(d.badge, d.tooltip, d.color ? new vscode.ThemeColor(d.color) : undefined);
      out.propagate = d.propagate;
      return out;
    },
  };
  let timer: NodeJS.Timeout | undefined;
  const later = (): void => {
    if (timer) clearTimeout(timer);
    timer = setTimeout(() => void tree.refresh(), REFRESH_MS);
  };
  const watcher = vscode.workspace.createFileSystemWatcher(new vscode.RelativePattern(root, '.mole/**'));
  ctx.subscriptions.push(
    changed,
    tree.onChange(() => changed.fire(undefined)),
    vscode.window.registerFileDecorationProvider(provider),
    watcher,
    watcher.onDidChange(later),
    watcher.onDidCreate(later),
    watcher.onDidDelete(later),
    vscode.workspace.onDidSaveTextDocument(later),
    { dispose: () => timer && clearTimeout(timer) },
  );
  void tree.refresh();
  if (process.env.MOLE_TREE_CHECK) treeCheck(tree, root, provider, process.env.MOLE_TREE_CHECK);
}
