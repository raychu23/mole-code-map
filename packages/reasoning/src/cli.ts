#!/usr/bin/env node
// Mole reasoning CLI (T42): reads a JSON framework on stdin, writes the
// grounded-evaluation JSON result on stdout.
//
// usage:
//   echo '{"framework":{"args":[{"id":"a"},{"id":"b"}],"attacks":[["a","b"],["b","a"]]},"audience":["safety","speed"]}' \
//     | node packages/reasoning/dist/src/cli.js
import { evaluate } from './engine.js';
import type { Audience, Framework } from './types.js';

async function readStdin(): Promise<string> {
  const chunks: Buffer[] = [];
  for await (const chunk of process.stdin) chunks.push(chunk as Buffer);
  return Buffer.concat(chunks).toString('utf8');
}

interface CliInput {
  framework: Framework;
  audience?: Audience;
}

async function main(): Promise<void> {
  const raw = await readStdin();
  let input: CliInput;
  try {
    input = JSON.parse(raw) as CliInput;
  } catch (err) {
    process.stderr.write(`invalid JSON on stdin: ${(err as Error).message}\n`);
    process.exitCode = 1;
    return;
  }
  const result = evaluate(input.framework, input.audience);
  process.stdout.write(`${JSON.stringify(result)}\n`);
}

main().catch((err) => {
  process.stderr.write(`${(err as Error).stack ?? (err as Error).message}\n`);
  process.exitCode = 1;
});
