// T53: own ~60-line Okapi BM25 (Robertson & Sparck Jones), zero model calls, zero network, no new runtime
// dependency. prior-art.md: wink-bm25-text-search is the closest off-the-shelf match (same k1=1.2/b=0.75
// defaults); reimplemented here so the tokenizer can be tuned to code-shaped text (paths, camelCase/kebab-case,
// hunk lines) in place rather than fighting a general-text tokenizer.
const STOPWORDS = new Set([
  'the', 'a', 'an', 'and', 'or', 'of', 'to', 'in', 'on', 'for', 'is', 'are', 'be', 'this', 'that', 'with', 'as',
  'by', 'at', 'from', 'it', 'its', 'was', 'were', 'has', 'have', 'had', 'not', 'but', 'so', 'if', 'than', 'then',
]);

/** Splits path separators, camelCase/PascalCase boundaries, and punctuation into spaces, lowercases, and drops
 *  stopwords + tokens shorter than 2 chars + tokens with no letters (pure numbers/punctuation noise). */
export function tokenize(text: string): string[] {
  const spaced = text
    .replace(/([a-z0-9])([A-Z])/g, '$1 $2') // camelCase / PascalCase boundary
    .replace(/[/\\._\-:#"'`(),;{}[\]<>=+*!?@%^&|~$]+/g, ' ');
  return spaced
    .toLowerCase()
    .split(/\s+/)
    .filter((t) => t.length >= 2 && !STOPWORDS.has(t) && /[a-z]/.test(t));
}

export interface Bm25Hit {
  id: string;
  score: number;
}

interface Doc {
  id: string;
  tf: Map<string, number>;
  len: number;
}

/** Okapi BM25 over an in-memory corpus. `add` every document once, then `score` a query against all of them.
 *  k1 (term-frequency saturation) and b (length-normalization strength) default to the standard 1.2 / 0.75. */
export class Bm25Index {
  private docs: Doc[] = [];
  private df = new Map<string, number>(); // document frequency per term
  private totalLen = 0;

  constructor(
    private k1 = 1.2,
    private b = 0.75,
  ) {}

  add(id: string, text: string): void {
    const tokens = tokenize(text);
    const tf = new Map<string, number>();
    for (const t of tokens) tf.set(t, (tf.get(t) ?? 0) + 1);
    this.docs.push({ id, tf, len: tokens.length });
    for (const t of tf.keys()) this.df.set(t, (this.df.get(t) ?? 0) + 1);
    this.totalLen += tokens.length;
  }

  private idf(term: string): number {
    const n = this.docs.length;
    const df = this.df.get(term) ?? 0;
    return Math.log((n - df + 0.5) / (df + 0.5) + 1);
  }

  score(queryText: string): Bm25Hit[] {
    if (this.docs.length === 0) return [];
    const avgLen = this.totalLen / this.docs.length || 1;
    const qTerms = new Set(tokenize(queryText));
    const hits: Bm25Hit[] = this.docs.map((doc) => {
      let score = 0;
      for (const term of qTerms) {
        const f = doc.tf.get(term) ?? 0;
        if (f === 0) continue;
        const idf = this.idf(term);
        score += (idf * (f * (this.k1 + 1))) / (f + this.k1 * (1 - this.b + this.b * (doc.len / avgLen)));
      }
      return { id: doc.id, score };
    });
    return hits.sort((a, b) => b.score - a.score);
  }
}
