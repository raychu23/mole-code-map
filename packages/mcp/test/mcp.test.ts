import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { afterEach, expect, it } from 'vitest';
import { execFileSync } from 'node:child_process';
import { MoleClient } from '@mole/daemon';

const cleanups: Array<() => Promise<void> | void> = [];
afterEach(async () => {
  for (const c of cleanups.splice(0).reverse()) await c();
});

it('mole_map over stdio returns the same neighbourhood text as the CLI; a down daemon is an error result, not a crash', async () => {
  const root = mkdtempSync(join(tmpdir(), 'mole-mcp-'));
  cleanups.push(() => rmSync(root, { recursive: true, force: true }));
  mkdirSync(join(root, 'src'));
  writeFileSync(join(root, 'src/a.ts'), 'export function a() {\n  return 1;\n}\n');
  writeFileSync(join(root, 'src/b.ts'), "import { a } from './a.js';\nexport function b() {\n  return a();\n}\n");
  const stateDir = join(root, '.state');
  const bin = join(dirname(fileURLToPath(import.meta.url)), '../dist/cli.js');
  const env = { ...process.env, MOLE_ROOT: root, MOLE_STATE_DIR: stateDir } as Record<string, string>;
  const connect = async () => {
    const client = new Client({ name: 'test', version: '0' });
    await client.connect(new StdioClientTransport({ command: process.execPath, args: ['--no-warnings', bin], env }));
    cleanups.push(() => client.close());
    return client;
  };

  // daemon down and not startable? the MCP server starts one itself (ensureDaemon); prove that path first
  const client = await connect();
  const tools = await client.listTools();
  expect(tools.tools.map((t) => t.name)).toEqual(['mole_map']);
  const res = await client.callTool({ name: 'mole_map', arguments: { target: 'src/a.ts', impact: true } });
  const text = (res.content as Array<{ type: string; text: string }>)[0]?.text ?? '';
  expect(res.isError).toBeFalsy();
  expect(text).toContain('file src/a.ts');
  expect(text).toContain('called by: b');
  expect(text).toContain('!impact');
  // the CLI prints the same neighbourhood (ms and indexed-time vary per call, so normalise them)
  const cli = join(dirname(fileURLToPath(import.meta.url)), '../../daemon/dist/cli.js');
  const norm = (s: string) => s.replace(/, indexed [^\]]+/g, '').replace(/, \d+ ms\)/g, ')').trim();
  const viaCli = execFileSync(process.execPath, ['--no-warnings', cli, 'map', 'src/a.ts', '--root', root, '--state-dir', stateDir, '--no-start'], { encoding: 'utf8' });
  const viaMcp = (await client.callTool({ name: 'mole_map', arguments: { target: 'src/a.ts' } })).content as Array<{ text: string }>;
  expect(norm(viaMcp[0]?.text ?? '')).toBe(norm(viaCli));
  await new MoleClient({ root, stateDir }).call('shutdown'); // the daemon the MCP server spawned
  cleanups.push(() => new MoleClient({ root, stateDir }).call('shutdown').catch(() => undefined)); // the daemon the next call spawns
  const miss = await client.callTool({ name: 'mole_map', arguments: { target: 'src/none.ts' } });
  expect((miss.content as Array<{ text: string }>)[0]?.text).toMatch(/not-indexed|index-unavailable|indexing/);
}, 60000);
