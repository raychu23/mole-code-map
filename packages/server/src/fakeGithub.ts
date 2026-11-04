// A fake GitHub API (non-goal: never a real GitHub App/marketplace). Records every
// "posted" check-run/notification so tests and the bench can assert 0 lost notifications.
import http from 'node:http';

export interface FakeGithubApi {
  url: string;
  received: { orgId: string; ref: string; payload: unknown; at: number }[];
  postCheckRun(orgId: string, ref: string, payload: unknown): Promise<void>;
  close(): Promise<void>;
}

export async function startFakeGithubApi(): Promise<FakeGithubApi> {
  const received: FakeGithubApi['received'] = [];
  const server = http.createServer((req, res) => {
    let body = '';
    req.on('data', (c) => (body += c));
    req.on('end', () => {
      try {
        received.push({ ...JSON.parse(body), at: Date.now() });
      } catch {
        // ignore malformed bodies in the fake
      }
      res.writeHead(201, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ ok: true }));
    });
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const addr = server.address();
  const url = typeof addr === 'object' && addr ? `http://127.0.0.1:${addr.port}` : 'http://127.0.0.1:0';
  return {
    url,
    received,
    async postCheckRun(orgId, ref, payload) {
      await fetch(`${url}/check-runs`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ orgId, ref, payload }),
      });
    },
    async close() {
      await new Promise<void>((resolve) => server.close(() => resolve()));
    },
  };
}
