// npm pack -> install the tarball into an isolated temp dir (no access to this repo's node_modules) ->
// exercise `mole --help`, `mole rules`, `mole check --worktree` on a tiny scratch git fixture with one
// .mole decision rule, plus a real MCP initialize + tools/list JSON-RPC exchange with mole-mcp over stdio.
// Never publishes. Writes a JSON report next to this script's caller output (stdout) and exits non-zero
// on any failed check.
import { execFileSync, execSync, spawn } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const pkgDir = resolve(dirname(fileURLToPath(import.meta.url)), '..'); // release/mole-code
const report = { steps: {} };
const fail = [];

async function step(name, fn) {
  try {
    const out = await fn();
    report.steps[name] = { ok: true, ...out };
  } catch (e) {
    report.steps[name] = { ok: false, error: String(e.stderr ?? e.stdout ?? e.message ?? e) };
    fail.push(name);
  }
}

// 1. build
await step('build', () => {
  execFileSync('node', [join(pkgDir, 'tools/build.mjs')], { cwd: pkgDir, encoding: 'utf8' });
  return {};
});

// 2. npm pack
let tarball;
await step('pack', () => {
  const out = execFileSync('npm', ['pack', '--silent'], { cwd: pkgDir, encoding: 'utf8' }).trim();
  tarball = resolve(pkgDir, out.split('\n').pop());
  const size = Buffer.byteLength(readFileSync(tarball));
  return { tarball, bytes: size, kb: Math.round(size / 1024) };
});

// 2b. npm pack --dry-run must list LICENSE (D97 requirement: LICENSE copied into the package at build time)
await step('pack-dry-run lists LICENSE', () => {
  const out = execFileSync('npm', ['pack', '--dry-run', '--json'], { cwd: pkgDir, encoding: 'utf8' });
  const [entry] = JSON.parse(out);
  const files = entry.files.map((f) => f.path);
  if (!files.includes('LICENSE')) throw new Error(`LICENSE missing from npm pack --dry-run files: ${files.join(', ')}`);
  return { files };
});

// 3. install the tarball into an isolated temp dir with NO access to this repo's node_modules
const isolated = mkdtempSync(join(tmpdir(), 'mole-code-install-'));
await step('install-isolated', () => {
  writeFileSync(join(isolated, 'package.json'), JSON.stringify({ name: 'mole-code-smoke', private: true, version: '0.0.0' }, null, 2));
  // --prefix + no workspaces discovery: npm must resolve everything from the registry / the tarball, not ../../node_modules
  const out = execFileSync('npm', ['install', '--no-audit', '--no-fund', '--no-workspaces', tarball], { cwd: isolated, encoding: 'utf8', env: { ...process.env, npm_config_workspaces: 'false' } });
  const binMole = join(isolated, 'node_modules/.bin/mole');
  const binMcp = join(isolated, 'node_modules/.bin/mole-mcp');
  if (!existsSync(binMole) || !existsSync(binMcp)) throw new Error(`bins missing after install: mole=${existsSync(binMole)} mole-mcp=${existsSync(binMcp)}`);
  return { isolated, installLogTail: out.split('\n').slice(-5).join('\n'), binMole, binMcp };
});
const binMole = join(isolated, 'node_modules/.bin/mole');
const binMcp = join(isolated, 'node_modules/.bin/mole-mcp');

// 3b. the installed package directory is also a valid Claude Code plugin root (D97: this package carries
// the plugin files too, resolved via what would be ${CLAUDE_PLUGIN_ROOT})
await step('installed package is a plugin root', () => {
  const pluginDir = join(isolated, 'node_modules/mole-code');
  for (const rel of ['.claude-plugin/plugin.json', 'hooks/hooks.json', '.mcp.json', 'scripts/lib.mjs', 'scripts/session-start.mjs']) {
    if (!existsSync(join(pluginDir, rel))) throw new Error(`missing plugin file in installed package: ${rel}`);
  }
  return { pluginDir };
});

// 4. mole help (bare --help flag maps to cmd '--help', not 'help', which this CLI exits 2 for by design;
// no-arg / `mole help` is the exit-0 path; the usage line goes to stderr, so shell-redirect it into stdout),
// from the isolated dir, with no access to this repo at all
await step('mole help', () => {
  const out = execSync(`${JSON.stringify(binMole)} help 2>&1`, { cwd: isolated, encoding: 'utf8' });
  if (!/usage: mole/.test(out)) throw new Error(`unexpected output: ${out.slice(0, 200)}`);
  return { output: out.trim() };
});

// 5. tiny scratch git repo with one .mole decision rule, outside the repo and outside `isolated`
const fixture = mkdtempSync(join(tmpdir(), 'mole-code-fixture-'));
await step('fixture', () => {
  mkdirSync(join(fixture, 'src'), { recursive: true });
  mkdirSync(join(fixture, '.mole/decisions'), { recursive: true });
  writeFileSync(join(fixture, 'src/a.ts'), "import { b } from './b';\nexport function a() { return b(); }\n");
  writeFileSync(join(fixture, 'src/b.ts'), 'export function b() { return 1; }\n');
  writeFileSync(
    join(fixture, '.mole/decisions/0001-no-a-to-b.md'),
    [
      '---',
      'id: 0001',
      'title: a.ts must not import b.ts',
      'status: accepted',
      'rules:',
      '  - forbid: import',
      '    from: src/a.ts',
      '    to: src/b.ts',
      '    why: T85/T86 install-check fixture rule',
      '---',
      '# a.ts must not import b.ts',
      '',
    ].join('\n'),
  );
  execFileSync('git', ['init', '-q'], { cwd: fixture });
  execFileSync('git', ['config', 'user.email', 'a@b.c'], { cwd: fixture });
  execFileSync('git', ['config', 'user.name', 'tester'], { cwd: fixture });
  execFileSync('git', ['add', '-A'], { cwd: fixture });
  execFileSync('git', ['commit', '-q', '-m', 'init'], { cwd: fixture });
  return { fixture };
});

// 6. mole rules: expects exit 1 (one violation found) -- also the test for the vendored dependency-cruiser:
// no npm dependency on it is declared (package.json's dependencies is {}), so this only passes if the
// tarball itself ships a working dependency-cruiser under dist/node_modules/.
await step('mole rules', () => {
  let out, code;
  try {
    out = execFileSync(binMole, ['rules', '--root', fixture], { cwd: isolated, encoding: 'utf8' });
    code = 0;
  } catch (e) {
    out = String(e.stdout ?? '');
    code = e.status;
  }
  if (code !== 1) throw new Error(`expected exit 1 (a violation), got ${code}: ${out}`);
  if (!/breaks 0001/.test(out)) throw new Error(`expected the 0001 violation in output: ${out}`);
  return { exitCode: code, output: out.trim() };
});

// 7. mole check --worktree: expects exit 0 (clean working tree, no past fixes yet)
await step('mole check', () => {
  const out = execFileSync(binMole, ['check', '--worktree', '--root', fixture], { cwd: isolated, encoding: 'utf8' });
  if (!/mole check working tree/.test(out)) throw new Error(`unexpected output: ${out}`);
  return { output: out.trim() };
});

// T87 review 2 (HIGH): @mole/agentstate and @mole/coverage are regular runtime dependencies of the daemon
// CLI, @mole/steer and the MCP server (same as on main) -- only the PUBLIC SOURCE EXPORT (scripts/export-public.mjs)
// is allowed to swap them for a stub; the installed npm tarball (built here the same way the real release is)
// must bundle the real packages and answer real data or the same "no run"/"no agent run" message main gives,
// never "not available in this build". 8-10 below are this check, on this tarball, in the isolated install dir.
const NOT_AVAILABLE = /not available in this build/;

// 8. mole runs / mole agents / mole steer query: real agentstate-backed subcommands, no daemon
await step('mole runs', () => {
  const out = execFileSync(binMole, ['runs', '--root', fixture], { cwd: isolated, encoding: 'utf8' });
  if (NOT_AVAILABLE.test(out)) throw new Error(`mole runs answered "not available": ${out}`);
  if (!/mole: no runs/.test(out)) throw new Error(`expected the no-runs message (same as main, empty fixture): ${out}`);
  return { output: out.trim() };
});
await step('mole agents', () => {
  const out = execFileSync(binMole, ['agents', 'src/a.ts', '--root', fixture], { cwd: isolated, encoding: 'utf8' });
  if (NOT_AVAILABLE.test(out)) throw new Error(`mole agents answered "not available": ${out}`);
  if (!/mole: no agent run edited/.test(out)) throw new Error(`expected the no-agent-edit message: ${out}`);
  return { output: out.trim() };
});
await step('mole steer query', () => {
  const out = execFileSync(binMole, ['steer', 'query', '--session', 'nope', '--root', fixture], { cwd: isolated, encoding: 'utf8' });
  if (NOT_AVAILABLE.test(out)) throw new Error(`mole steer query answered "not available": ${out}`);
  if (!/mole: no run nope/.test(out)) throw new Error(`expected the no-run message (@mole/agentstate's queryAgentState, same as main): ${out}`);
  return { output: out.trim() };
});

// 9. mole-mcp: JSON-RPC initialize + tools/list over stdio, then tools/call for the 5 agentstate/coverage tools
await step('mole-mcp initialize + tools/list + agentstate/coverage tools/call', async () => {
  const p = spawn(binMcp, [], { cwd: fixture, stdio: ['pipe', 'pipe', 'pipe'] });
  let buf = '';
  let errBuf = '';
  p.stdout.on('data', (d) => (buf += d.toString()));
  p.stderr.on('data', (d) => (errBuf += d.toString()));
  const send = (msg) => p.stdin.write(`${JSON.stringify(msg)}\n`);
  send({ jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: '2024-11-05', capabilities: {}, clientInfo: { name: 'mole-code-install-check', version: '0.0.1' } } });
  await new Promise((r) => setTimeout(r, 1200));
  send({ jsonrpc: '2.0', id: 2, method: 'tools/list', params: {} });
  await new Promise((r) => setTimeout(r, 1200));
  const calls = [
    { id: 10, name: 'mole_coverage', arguments: {} },
    { id: 11, name: 'mole_claims', arguments: { run: 'nope' } },
    { id: 12, name: 'mole_tried', arguments: { target: 'src/a.ts' } },
    { id: 13, name: 'mole_collisions', arguments: {} },
    { id: 14, name: 'mole_agent_intent', arguments: { target: 'src/a.ts' } },
  ];
  for (const c of calls) send({ jsonrpc: '2.0', id: c.id, method: 'tools/call', params: { name: c.name, arguments: c.arguments } });
  // mole_coverage/mole_tried/mole_collisions/mole_agent_intent scan this machine's real ~/.claude, ~/.codex,
  // ~/.agent-cache session logs (defaultSources()) -- on a machine with a lot of agent history that scan alone can
  // take 20+ seconds, nothing to do with this fix; poll for all 5 responses up to 60s instead of a fixed sleep.
  const expectedIds = new Set(calls.map((c) => c.id));
  let msgs = [];
  const deadline = Date.now() + 60_000;
  while (Date.now() < deadline) {
    const lines = buf.trim().split('\n').filter(Boolean);
    msgs = lines.map((l) => JSON.parse(l));
    const have = new Set(msgs.map((m) => m.id));
    if ([...expectedIds].every((id) => have.has(id))) break;
    await new Promise((r) => setTimeout(r, 500));
  }
  p.kill();
  const init = msgs.find((m) => m.id === 1);
  const list = msgs.find((m) => m.id === 2);
  if (!init?.result?.serverInfo) throw new Error(`no initialize result (stderr: ${errBuf.slice(0, 300)})`);
  if (!Array.isArray(list?.result?.tools) || list.result.tools.length === 0) throw new Error('no tools/list result');
  const callResults = {};
  for (const c of calls) {
    const m = msgs.find((x) => x.id === c.id);
    if (!m) throw new Error(`no tools/call response for ${c.name} (stderr: ${errBuf.slice(0, 500)})`);
    const text = (m.result?.content ?? []).map((x) => x.text).join('\n');
    if (m.result?.isError && NOT_AVAILABLE.test(text)) throw new Error(`${c.name} answered "not available": ${text}`);
    if (NOT_AVAILABLE.test(text)) throw new Error(`${c.name} answered "not available" in content: ${text}`);
    callResults[c.name] = { isError: m.result?.isError ?? false, text: text.slice(0, 200) };
  }
  return { serverInfo: init.result.serverInfo, toolCount: list.result.tools.length, toolNames: list.result.tools.map((t) => t.name), callResults };
});

// cleanup
for (const dir of [isolated, fixture]) rmSync(dir, { recursive: true, force: true });
if (tarball && existsSync(tarball)) rmSync(tarball, { force: true });

report.ok = fail.length === 0;
report.failed = fail;
console.log(JSON.stringify(report, null, 2));
process.exit(report.ok ? 0 : 1);
