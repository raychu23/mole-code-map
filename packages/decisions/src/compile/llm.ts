// The ONE place compile-at-capture and the cascade call out to a real model (T46). `hermesLlmClient` shells to the
// `hermes` CLI exactly like (internal reference removed)'s bench arms: a
// pure text call, no tools, real tokens + cost via --usage-file. Product code takes an `LlmClient`, never this
// function, so every caller (draft.ts, cascade.ts) is testable with a fake and swappable for a cheaper/local model.
import { execFileSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { LlmClient, LlmResult } from './types.js';

export interface HermesLlmOptions {
  model?: string;
  provider?: string;
  /** seconds; hermes -z can be slow on a loaded machine (default 120s, same as run_llm_arms.py) */
  timeoutMs?: number;
}

export function hermesLlmClient(opts: HermesLlmOptions = {}): LlmClient {
  const model = opts.model ?? 'claude-sonnet-5';
  const provider = opts.provider ?? 'anthropic';
  const timeout = opts.timeoutMs ?? 120_000;
  return {
    async complete(prompt: string): Promise<LlmResult> {
      const dir = mkdtempSync(join(tmpdir(), 'mole-llm-usage-'));
      const usageFile = join(dir, 'usage.json');
      try {
        const out = execFileSync(
          'hermes',
          ['-z', prompt, '-m', model, '--provider', provider, '-t', '', '--safe-mode', '--usage-file', usageFile],
          { encoding: 'utf8', maxBuffer: 1024 * 1024 * 16, timeout },
        );
        let usage: LlmResult['usage'] = {};
        try {
          const u = JSON.parse(readFileSync(usageFile, 'utf8')) as Record<string, number>;
          usage = {
            inputTokens: u.input_tokens ?? u.inputTokens,
            outputTokens: u.output_tokens ?? u.outputTokens,
            costUsd: u.estimated_cost_usd ?? u.costUsd,
          };
        } catch {
          // no usage file written (older hermes build, or the call failed before usage was recorded): report no usage
          // rather than guessing a cost.
        }
        return { text: out.trim(), usage };
      } finally {
        rmSync(dir, { recursive: true, force: true });
      }
    },
  };
}
