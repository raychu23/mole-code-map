/** Deterministic duplicate suggestions: normalized exact match first, then
 * fixed-seed MinHash + LSH candidate generation and exact 3-gram Jaccard.
 * This module never writes, merges, or selects a canonical record. */
export type DuplicateRecord = { id: string; title: string; body?: string };
export type DuplicateSuggestion = { id: string; kind: 'exact' | 'near'; score: number };

const SEEDS = Array.from({ length: 32 }, (_, i) => 0x9e3779b9 ^ Math.imul(i + 1, 0x85ebca6b));
const BAND_SIZE = 4;
const NEAR_THRESHOLD = 0.8;

function normalized(record: Pick<DuplicateRecord, 'title' | 'body'>): string {
  return `${record.title}\n${record.body ?? ''}`
    .normalize('NFKC')
    .toLowerCase()
    .replace(/[^\p{L}\p{N}]+/gu, ' ')
    .trim()
    .replace(/\s+/g, ' ');
}

function shingles(text: string): Set<string> {
  if (!text) return new Set();
  const padded = ` ${text} `;
  if (padded.length < 3) return new Set([padded]);
  const out = new Set<string>();
  for (let i = 0; i <= padded.length - 3; i++) out.add(padded.slice(i, i + 3));
  return out;
}

function hash32(text: string, seed: number): number {
  let h = seed >>> 0;
  for (let i = 0; i < text.length; i++) h = Math.imul(h ^ text.charCodeAt(i), 0x01000193) >>> 0;
  return h >>> 0;
}

function minhash(items: Set<string>): number[] {
  if (items.size === 0) return SEEDS.map(() => 0xffffffff);
  return SEEDS.map((seed) => {
    let minimum = 0xffffffff;
    for (const item of items) minimum = Math.min(minimum, hash32(item, seed));
    return minimum;
  });
}

function bandKeys(signature: number[]): string[] {
  const out: string[] = [];
  for (let start = 0; start < signature.length; start += BAND_SIZE) out.push(`${start / BAND_SIZE}:${signature.slice(start, start + BAND_SIZE).join(',')}`);
  return out;
}

function jaccard(a: Set<string>, b: Set<string>): number {
  let shared = 0;
  for (const item of a) if (b.has(item)) shared++;
  const total = a.size + b.size - shared;
  return total === 0 ? 0 : shared / total;
}

export function suggestDuplicates(incoming: DuplicateRecord, existing: DuplicateRecord[]): DuplicateSuggestion[] {
  const input = normalized(incoming);
  const inputShingles = shingles(input);
  const exact = existing.filter((candidate) => candidate.id !== incoming.id && normalized(candidate) === input);
  const exactIds = new Set(exact.map((candidate) => candidate.id));
  const buckets = new Map<string, DuplicateRecord[]>();
  for (const candidate of existing) {
    if (candidate.id === incoming.id || exactIds.has(candidate.id)) continue;
    for (const key of bandKeys(minhash(shingles(normalized(candidate))))) {
      const matches = buckets.get(key) ?? [];
      matches.push(candidate);
      buckets.set(key, matches);
    }
  }
  const candidates = new Map<string, DuplicateRecord>();
  for (const key of bandKeys(minhash(inputShingles))) for (const candidate of buckets.get(key) ?? []) candidates.set(candidate.id, candidate);
  const near: DuplicateSuggestion[] = [...candidates.values()]
    .map((candidate) => ({ id: candidate.id, kind: 'near' as const, score: jaccard(inputShingles, shingles(normalized(candidate))) }))
    .filter((candidate) => candidate.score >= NEAR_THRESHOLD);
  return [...exact.map((candidate) => ({ id: candidate.id, kind: 'exact' as const, score: 1 })), ...near].sort((a, b) => (b.score - a.score) || a.id.localeCompare(b.id));
}
