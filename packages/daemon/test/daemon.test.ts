import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { formatNeighborhood, MAX_MAP_NODES } from '@mole/core';
import { TsIndexer } from '@mole/indexer';
import { AlreadyRunning, Daemon, lockPath, MoleClient, neighborhood, normalizeTarget } from '../src/index.js';

const cleanups: Array<() => Promise<void> | void> = [];
afterEach(async () => {
  for (const c of cleanups.splice(0).reverse()) await c();
});

function repo(files: Record<string, string>): string {
  const root = mkdtempSync(join(tmpdir(), 'mole-d-'));
  cleanups.push(() => rmSync(root, { recursive: true, force: true }));
  for (const [p, body] of Object.entries(files)) {
    mkdirSync(dirname(join(root, p)), { recursive: true });
    writeFileSync(join(root, p), body);
  }
  return root;
}

const SMALL = {
  'src/util.ts': 'export function clamp(n: number) {\n  return n;\n}\nexport function unused() {\n  return 0;\n}\n',
  'src/svc.ts': "import { clamp } from './util.js';\nexport class Svc {\n  find(id: number) {\n    return clamp(id);\n  }\n}\nexport function make() {\n  return new Svc();\n}\n",
  'src/app.ts': "import { make } from './svc.js';\nexport function main() {\n  return make().find(1);\n}\n",
};

function indexed(files: Record<string, string>) {
  const root = repo(files);
  const ix = new TsIndexer({ root, commit: 'abc1234' });
  ix.indexAll();
  cleanups.push(() => ix.close());
  return ix.db;
}

describe('idle shutdown (T9)', () => {
  it('a daemon with no requests stops itself and removes its lock and socket; requests keep it alive', async () => {
    const root = repo(SMALL);
    const stateDir = join(root, '.state');
    const d = new Daemon({ root, stateDir, watch: false, idleMs: 600 });
    await d.start();
    cleanups.push(() => d.stop());
    const c = new MoleClient({ root, stateDir });
    await until(() => c.map('src/svc.ts'), (x) => x.state === 'ok');
    // keep asking for 1.5 s (> idleMs): it must stay up
    const end = Date.now() + 1500;
    while (Date.now() < end) {
      expect(await c.running()).toBe(true);
      await new Promise((r) => setTimeout(r, 150));
    }
    // now go quiet: it must stop by itself
    await Promise.race([d.closed, new Promise((_, no) => setTimeout(() => no(new Error('daemon did not stop when idle')), 5000))]);
    expect(await c.running()).toBe(false);
    const down = await c.map('src/svc.ts');
    expect(down.state).toBe('index-unavailable'); // the editor reads this and starts a new daemon
  }, 30000);
});

describe('default sources (T9)', () => {
  it('uses src when it exists, the whole folder when it does not, and never overrides an explicit choice', async () => {
    const { defaultSources } = await import('../src/detect.js');
    const withSrc = repo(SMALL);
    expect(defaultSources(withSrc)).toEqual({});
    const noSrc = mkdtempSync(join(tmpdir(), 'mole-nosrc-'));
    cleanups.push(() => rmSync(noSrc, { recursive: true, force: true }));
    expect(defaultSources(noSrc)).toEqual({ srcDir: '.' });
    expect(defaultSources(noSrc, 'tsconfig.json')).toEqual({ tsconfig: 'tsconfig.json', srcDir: undefined });
    expect(defaultSources(noSrc, undefined, 'lib')).toEqual({ tsconfig: undefined, srcDir: 'lib' });
  });

  it('a repo with .ts files in packages/*/src and no root src folder is indexed, not left empty', async () => {
    const root = mkdtempSync(join(tmpdir(), 'mole-mono-'));
    cleanups.push(() => rmSync(root, { recursive: true, force: true }));
    mkdirSync(join(root, 'packages/a/src'), { recursive: true });
    writeFileSync(join(root, 'packages/a/src/x.ts'), 'export function x(): number { return 1; }\n');
    writeFileSync(join(root, 'packages/a/src/y.ts'), "import { x } from './x';\nexport const y = x();\n");
    const { defaultSources } = await import('../src/detect.js');
    const d = new Daemon({ root, stateDir: join(root, '.state'), watch: false, ...defaultSources(root) });
    await d.start();
    cleanups.push(() => d.stop());
    const c = new MoleClient({ root, stateDir: join(root, '.state') });
    const m = await until(() => c.map('packages/a/src/x.ts'), (r) => r.state === 'ok');
    expect(m.nodes.some((n) => n.name === 'x')).toBe(true);
  }, 30000);
});

describe('call-site lines (T7)', () => {
  // doIt is declared on line 4 of user.ts and calls target() on lines 6 and 8
  const FILES = {
    'src/lib.ts': 'export function target() {\n  return 1;\n}\n',
    'src/user.ts': "import { target } from './lib.js';\n\n\nexport function doIt() {\n  const a = 1;\n  target();\n  const b = 2;\n  return target() + a + b;\n}\n",
  };

  it('a caller carries the first call-site line and the site count, next to its declaration line', () => {
    const n = neighborhood(indexed(FILES), 'src/lib.ts#target');
    const caller = n.nodes.find((x) => x.role === 'caller' && x.name === 'doIt');
    expect(caller).toMatchObject({ path: 'src/user.ts', line: 4, site: { path: 'src/user.ts', line: 6, count: 2 } });
    const text = formatNeighborhood(n);
    expect(text).toContain('doIt src/user.ts:6 ×2');
    expect(text).not.toContain('doIt src/user.ts:4');
  });

  it('file-level callers and importers print the site line and count in the text map too', () => {
    const files = { ...FILES, 'src/top.ts': "import { target } from './lib.js';\ntarget();\ntarget();\n" };
    const text = formatNeighborhood(neighborhood(indexed(files), 'src/lib.ts'));
    expect(text).toMatch(/called by: .*src\/top\.ts:2 ×2/);
    expect(text).toMatch(/imported by: .*src\/user\.ts:1/); // top.ts is both caller and importer: the stronger role (caller) keeps it
  });

  it('an importer carries the import statement line', () => {
    const n = neighborhood(indexed(FILES), 'src/lib.ts');
    expect(n.nodes.find((x) => x.role === 'importer')).toMatchObject({ path: 'src/user.ts', site: { path: 'src/user.ts', line: 1, count: 1 } });
  });

  it('callees keep the declaration line (that is where you go next)', () => {
    const n = neighborhood(indexed(FILES), 'src/user.ts#doIt');
    const callee = n.nodes.find((x) => x.role === 'callee' && x.name === 'target');
    expect(callee).toMatchObject({ path: 'src/lib.ts', line: 1 });
    expect(callee?.site).toBeUndefined();
  });
});

describe('neighborhood (pure query)', () => {
  it('file map lists its symbols, callers, callees and importers', () => {
    const n = neighborhood(indexed(SMALL), 'src/svc.ts');
    expect(n.state).toBe('ok');
    expect(n.focus).toMatchObject({ kind: 'file', path: 'src/svc.ts' });
    const by = (role: string) => n.nodes.filter((x) => x.role === role).map((x) => x.name).sort();
    expect(by('own')).toEqual(['Svc', 'make']); // methods fold into their class on a file map
    expect(by('callee')).toContain('clamp');
    expect(by('caller')).toContain('main');
    expect(n.nodes.find((x) => x.role === 'importer')?.path).toBe('src/app.ts');
    expect(n.nodes.find((x) => x.role === 'imported')?.path).toBe('src/util.ts');
    expect(n.nodes.every((x) => x.evidence.commit === 'abc1234' && x.evidence.line >= 1)).toBe(true);
  });

  it('symbol map: container file, callers and callees', () => {
    const n = neighborhood(indexed(SMALL), 'src/svc.ts#Svc.find');
    expect(n.focus).toMatchObject({ kind: 'method', name: 'find' });
    expect(n.nodes.find((x) => x.role === 'container')?.path).toBe('src/svc.ts');
    expect(n.nodes.filter((x) => x.role === 'callee').map((x) => x.name)).toContain('clamp');
    expect(n.nodes.filter((x) => x.role === 'caller').map((x) => x.name)).toContain('main');
  });

  it('impact view flags transitive callers', () => {
    const n = neighborhood(indexed(SMALL), 'src/util.ts', { impact: true });
    const hit = new Map(n.nodes.map((x) => [x.name, x.impacted === true]));
    expect(hit.get('clamp')).toBe(true); // called by Svc.find
    expect(hit.get('unused')).toBe(false); // nobody calls it
  });

  it('a file outside the index is "not-indexed", not an error', () => {
    const n = neighborhood(indexed(SMALL), 'src/nope.ts');
    expect(n.state).toBe('not-indexed');
    expect(n.nodes).toEqual([]);
    expect(formatNeighborhood(n)).toContain('not-indexed');
  });

  it('caps the map at MAX_MAP_NODES and groups the rest as +N more', () => {
    const many: Record<string, string> = {};
    let hub = '';
    for (let i = 0; i < 40; i++) {
      many[`src/f${i}.ts`] = `export function f${i}() {\n  return ${i};\n}\n`;
      hub += `import { f${i} } from './f${i}.js';\n`;
    }
    hub += `export function hub() {\n  return [${Array.from({ length: 40 }, (_, i) => `f${i}()`).join(', ')}];\n}\n`;
    many['src/hub.ts'] = hub;
    const n = neighborhood(indexed(many), 'src/hub.ts');
    expect(n.nodes.length).toBe(MAX_MAP_NODES);
    expect(n.nodes[0]?.role).toBe('focus');
    expect(n.more.reduce((a, m) => a + m.count, 0)).toBeGreaterThan(0);
    expect(formatNeighborhood(n)).toMatch(/\+\d+ more/);
    const ids = new Set(n.nodes.map((x) => x.id));
    expect(n.edges.every((e) => ids.has(e.from) && ids.has(e.to))).toBe(true);
  });
});

describe('review fixes (T2 adversarial review)', () => {
  const CHAIN = {
    'src/util.ts': 'export function clamp(n: number) {\n  return n;\n}\nexport function rec(n: number): number {\n  return n ? rec(n - 1) : 0;\n}\nexport function helper() {\n  return 1;\n}\nexport function useHelper() {\n  return helper();\n}\n',
    'src/a.ts': "import { clamp } from './util.js';\nexport function mid() {\n  return clamp(1);\n}\n",
    'src/b.ts': "import { mid } from './a.js';\nexport function top() {\n  return mid();\n}\nexport function top2() {\n  return mid();\n}\n",
  };

  it('impact reports transitive callers (not just the ones on the map) and a self-call is not "impacted"', () => {
    const db = indexed(CHAIN);
    const n = neighborhood(db, 'src/util.ts', { impact: true });
    expect(n.impactTotal).toBe(3); // mid (direct) + top + top2 (via mid)
    const flag = (name: string) => n.nodes.find((x) => x.name === name)?.impacted === true;
    expect(flag('clamp')).toBe(true); // called from another file
    expect(flag('rec')).toBe(false); // only calls itself
    expect(flag('helper')).toBe(false); // only called by useHelper in the same file
    expect(formatNeighborhood(n)).toContain('impact: 3 callers');
  });

  it('a "%" or "_" in a symbol target is literal, not a LIKE wildcard', () => {
    const db = indexed(CHAIN);
    expect(neighborhood(db, 'src/util.ts#%').state).toBe('not-indexed');
    expect(neighborhood(db, 'src/util.ts#cl_mp').state).toBe('not-indexed');
    expect(neighborhood(db, "src/util.ts#clamp' OR '1'='1").state).toBe('not-indexed');
    expect(neighborhood(db, 'src/util.ts#clamp').state).toBe('ok');
  });

  it('a bare name that matches several symbols names the others', () => {
    const db = indexed({ 'src/x.ts': 'export function dup() {\n  return 1;\n}\n', 'src/y.ts': 'export function dup() {\n  return 2;\n}\n' });
    const n = neighborhood(db, 'dup');
    expect(n.state).toBe('ok');
    expect(n.alternatives?.length).toBe(1);
    expect(formatNeighborhood(n)).toContain('also matches');
  });

  it('normalizeTarget: ./, backslashes and absolute paths inside the repo all mean the repo-relative path', () => {
    expect(normalizeTarget('/repo', './src/a.ts')).toBe('src/a.ts');
    expect(normalizeTarget('/repo', 'src\\a.ts')).toBe('src/a.ts');
    expect(normalizeTarget('/repo', '/repo/src/a.ts#Svc.find')).toBe('src/a.ts#Svc.find');
    expect(normalizeTarget('/repo', '/elsewhere/a.ts')).toBe('/elsewhere/a.ts');
    expect(normalizeTarget('/repo', 'clamp')).toBe('clamp');
  });
});

async function until<T>(fn: () => Promise<T>, ok: (v: T) => boolean, ms = 20000): Promise<T> {
  const end = Date.now() + ms;
  for (;;) {
    const v = await fn();
    if (ok(v) || Date.now() > end) return v;
    await new Promise((r) => setTimeout(r, 100));
  }
}

describe('daemon', () => {
  it('serves map over the socket, is the only writer, and re-indexes a changed file', async () => {
    const root = repo(SMALL);
    const stateDir = join(root, '.state');
    const d = new Daemon({ root, stateDir });
    await d.start();
    cleanups.push(() => d.stop());
    const c = new MoleClient({ root, stateDir });
    const n = await until(() => c.map('src/svc.ts'), (x) => x.state === 'ok');
    expect(n.state).toBe('ok');
    expect(n.nodes.some((x) => x.name === 'clamp')).toBe(true);
    expect((await c.status()).state).toBe('ready');

    writeFileSync(join(root, 'src/svc.ts'), SMALL['src/svc.ts'] + 'export function extra() {\n  return 1;\n}\n');
    await c.call('update', { paths: ['src/svc.ts'] });
    const n2 = await until(() => c.map('src/svc.ts'), (x) => x.nodes.some((y) => y.name === 'extra'));
    expect(n2.nodes.some((x) => x.name === 'extra')).toBe(true);
  }, 60000);

  it('one daemon per repo: a second start fails, a stale lock is taken over', async () => {
    const root = repo(SMALL);
    const stateDir = join(root, '.state');
    const d = new Daemon({ root, stateDir });
    await d.start();
    cleanups.push(() => d.stop());
    await expect(new Daemon({ root, stateDir }).start()).rejects.toBeInstanceOf(AlreadyRunning);
    await d.stop();
    writeFileSync(lockPath(stateDir, root), JSON.stringify({ pid: 2 ** 22 + 12345, socket: '/tmp/none.sock', root, startedAt: 0 }));
    const d2 = new Daemon({ root, stateDir });
    await d2.start(); // pid not alive → lock replaced
    cleanups.push(() => d2.stop());
    expect(await new MoleClient({ root, stateDir }).running()).toBe(true);
  }, 60000);

  it('FAILURE: daemon down → "index-unavailable", no throw', async () => {
    const root = repo(SMALL);
    const n = await new MoleClient({ root, stateDir: join(root, '.state'), timeoutMs: 500 }).map('src/svc.ts');
    expect(n.state).toBe('index-unavailable');
    expect(n.message).toMatch(/not reachable/);
  });

  it('FAILURE: file outside the index → "not-indexed" through the daemon', async () => {
    const root = repo(SMALL);
    const stateDir = join(root, '.state');
    const d = new Daemon({ root, stateDir });
    await d.start();
    cleanups.push(() => d.stop());
    const c = new MoleClient({ root, stateDir });
    await until(() => c.status(), (s) => s.state === 'ready');
    expect((await c.map('docs/readme.md')).state).toBe('not-indexed');
  }, 60000);
});

describe('daemon robustness (T2 review)', () => {
  it('worktrees sharing a state dir get separate daemons and indexes', async () => {
    const a = repo(SMALL);
    const b = repo({ ...SMALL, 'src/only-in-b.ts': 'export function onlyB() {\n  return 1;\n}\n' });
    const stateDir = join(a, '.state'); // shared, like a git common dir
    const da = new Daemon({ root: a, stateDir });
    const db_ = new Daemon({ root: b, stateDir });
    await da.start();
    await db_.start(); // would throw AlreadyRunning if the lock ignored the root
    cleanups.push(() => da.stop(), () => db_.stop());
    const ca = new MoleClient({ root: a, stateDir });
    const cb = new MoleClient({ root: b, stateDir });
    await until(() => cb.map('src/only-in-b.ts'), (x) => x.state === 'ok');
    expect((await cb.map('src/only-in-b.ts')).state).toBe('ok');
    await until(() => ca.map('src/svc.ts'), (x) => x.state === 'ok'); // A must have finished its own index, else it answers 'indexing' (race seen in the T5 review)
    expect((await ca.map('src/only-in-b.ts')).state).toBe('not-indexed'); // A's index never answers for B
  }, 60000);

  it('simultaneous starts for one repo: exactly one wins, the rest get AlreadyRunning (never a raw EEXIST)', async () => {
    const root = repo(SMALL);
    const stateDir = join(root, '.state');
    const ds = Array.from({ length: 6 }, () => new Daemon({ root, stateDir }));
    const res = await Promise.allSettled(ds.map((d) => d.start()));
    cleanups.push(...ds.map((d) => () => d.stop()));
    expect(res.filter((r) => r.status === 'fulfilled')).toHaveLength(1);
    for (const r of res) if (r.status === 'rejected') expect(r.reason).toBeInstanceOf(AlreadyRunning);
  }, 60000);

  it('a full re-index never makes an indexed file look "not-indexed"', async () => {
    const root = repo(SMALL);
    const stateDir = join(root, '.state');
    const d = new Daemon({ root, stateDir, watch: false });
    await d.start();
    cleanups.push(() => d.stop());
    const c = new MoleClient({ root, stateDir });
    await until(() => c.map('src/svc.ts'), (x) => x.state === 'ok');
    await c.call('reindex');
    const states: string[] = [];
    const end = Date.now() + 4000;
    while (Date.now() < end) {
      states.push((await c.map('src/svc.ts')).state);
      await new Promise((r) => setTimeout(r, 15));
    }
    expect(states.length).toBeGreaterThan(20);
    expect(states.filter((s) => s !== 'ok')).toEqual([]);
  }, 60000);
});
