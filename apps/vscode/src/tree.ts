// T30: the Explorer's decision badges, colors and folder cards over @mole/decisions' tree core (packages/decisions/src/tree).
// No vscode import and no runtime import of @mole/decisions (the loader is injected), so it is unit-testable and the extension
// host only loads the decision graph code when a workspace has a .mole folder. src/tree-provider.ts adapts it to VS Code.
import type { TreeIndex } from '@mole/decisions';
import { toRepoPath } from './paths.js';

/** Built-in theme colors, so the extension contributes no color ids. */
export const FLAG_COLORS = { green: 'charts.green', yellow: 'charts.yellow', red: 'charts.red' } as const;

export interface DecorationOut {
  badge?: string;
  /** the folder's intent card as plain text */
  tooltip?: string;
  color?: (typeof FLAG_COLORS)[keyof typeof FLAG_COLORS];
  /** false: every parent folder gets its own aggregate from the core, not VS Code's propagation */
  propagate: boolean;
}

export class FolderTree {
  private tree: TreeIndex | undefined;
  private listeners = new Set<() => void>();

  constructor(
    readonly root: string,
    private readonly load: (root: string) => TreeIndex | Promise<TreeIndex>,
    private readonly onError: (e: Error) => void = () => {},
  ) {}

  onChange(listener: () => void): { dispose(): void } {
    this.listeners.add(listener);
    return { dispose: () => void this.listeners.delete(listener) };
  }

  /** Every folder with a decoration or a card, once loaded (T30 proof artifact; undefined before the first refresh()). */
  get folders(): string[] | undefined {
    return this.tree?.folders;
  }

  /** Recompute the records + flags once; decorations then come from this cached index. A failed load clears it and never throws. */
  async refresh(): Promise<void> {
    try {
      this.tree = await this.load(this.root);
    } catch (e) {
      this.tree = undefined;
      this.onError(e instanceof Error ? e : new Error(String(e)));
    }
    for (const l of [...this.listeners]) l();
  }

  decorate(fsPath: string): DecorationOut | undefined {
    const tree = this.tree;
    if (!tree) return undefined;
    const rel = toRepoPath(this.root, fsPath);
    if (rel === undefined) return undefined;
    const d = tree.decoration(rel);
    if (!d) return undefined; // done-when 4: no records, nothing shown
    return {
      ...(d.badge ? { badge: d.badge } : {}),
      ...(d.tooltip ? { tooltip: d.tooltip } : {}),
      ...(d.flag ? { color: FLAG_COLORS[d.flag] } : {}),
      propagate: false,
    };
  }
}
