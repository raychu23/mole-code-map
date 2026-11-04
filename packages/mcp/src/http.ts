// (internal task reference removed): remote MCP endpoint over streamable HTTP, built on the same `createServer()`
// (server.ts) the stdio CLI (cli.ts) already uses -- no new tools, no new tool logic, just a second
// transport. Stateless mode (sessionIdGenerator: undefined, same choice packages/server/src/mcpServer.ts
// made for the team server's authed HTTP MCP, see that file's own comment): one McpServer + one transport
// per request, since an McpServer instance connects to exactly one transport at a time, and a brand-new
// `mole` repo-scoped server has no per-session state worth keeping across requests anyway (unlike the team
// server, which is per-org-token-scoped).
//
// SECURITY (T91 review fix HIGH 1): the MCP spec (2025-03-26 through 2026-07-28, all checked) says servers
// MUST validate the Origin header on every incoming connection to prevent DNS rebinding -- independent of
// bind address; a public attacker page can point DNS at 127.0.0.1 and have a victim's own browser fetch()
// this endpoint. The @modelcontextprotocol/sdk (^1.32.1) ships exactly this as
// StreamableHTTPServerTransportOptions.enableDnsRebindingProtection + allowedHosts/allowedOrigins (the SDK
// marks these two fields `@deprecated` in favour of "external middleware", but there is no external
// middleware here -- this file IS the middleware layer, so using the SDK's own enforcement is the correct,
// not-reinvented fix). Requests with a Host/Origin header that isn't one of the bound host/port's own
// values get the SDK's 403 JSON-RPC error response; a request with NO Origin header at all (most non-browser
// MCP clients, including this file's own tests and the official SDK client) is left unvalidated by the SDK,
// matching the spec's actual target (a browser-driven DNS-rebinding attack always carries an Origin).
//
// Bind policy: 127.0.0.1 by default (a loopback convenience, not a hardened remote service, same trust
// model docs/mcp.md documents for the stdio form). Binding PAST loopback is refused unless the caller
// explicitly opts in with BOTH `allowNonLoopback: true` AND a `bearerToken` (checked via `Authorization:
// Bearer <token>`) -- the DNS-rebinding fix above only closes the "another origin asks this server from the
// SAME machine" hole; it does nothing for "this server is reachable from other machines", which needs an
// auth layer, not origin validation. See docs/mcp.md "remote HTTP mode" for how an operator sets both.
import http from 'node:http';
import { createHash, timingSafeEqual } from 'node:crypto';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import { createServer, type MoleMcpOptions } from './server.js';

/** Constant-time string compare (T91 review round 2 fix MEDIUM): `req.headers.authorization !== expected`
 * short-circuits on the first mismatched byte, leaking the token's length and prefix through response
 * timing to anyone who can send repeated requests -- exactly the threat a bearer token exists to stop.
 * `timingSafeEqual` itself requires equal-length buffers (it throws otherwise, which would itself leak
 * length by error vs. no-error), so both sides are hashed with sha256 first -- fixed 32-byte output
 * regardless of input length, comparing digests rather than the raw secret directly. */
function timingSafeStringEqual(a: string, b: string): boolean {
  const hashA = createHash('sha256').update(a).digest();
  const hashB = createHash('sha256').update(b).digest();
  return timingSafeEqual(hashA, hashB);
}

/** T91 review round 2 fix MEDIUM: an IPv6 literal must be bracketed in a URL/Host/Origin authority
 * (`http://[::1]:PORT`, `Host: [::1]:PORT`) -- unbracketed `::1:PORT` is not a valid authority at all (the
 * colons are ambiguous with the port separator), so both `new URL()` and a browser's own Origin/Host would
 * never produce what this file was building and comparing against. `127.0.0.1`/`localhost`/any hostname
 * passes through unchanged; only a literal containing `:` (IPv6) gets bracketed, and only if not already. */
function bracketIfIPv6(host: string): string {
  if (host.includes(':') && !host.startsWith('[')) return `[${host}]`;
  return host;
}

export interface MoleHttpServer {
  url: string;
  close(): Promise<void>;
}

const LOOPBACK_HOSTS = new Set(['127.0.0.1', 'localhost', '::1', '[::1]']);

export interface MoleHttpListenOptions {
  port?: number;
  host?: string;
  /** Required together with `bearerToken` to bind a host other than loopback. */
  allowNonLoopback?: boolean;
  /** Checked against `Authorization: Bearer *** on every request once set. REQUIRED (with
   * allowNonLoopback) to bind past loopback; optional (defence in depth) on a loopback bind. */
  bearerToken?: string;
}

/** Starts a stateless streamable-HTTP MCP endpoint at POST/GET/DELETE `/mcp`, serving the exact same tools
 * as the stdio server (same `createServer(opts)`). One fresh McpServer + transport per request. */
export async function startMoleHttpServer(opts: MoleMcpOptions, listenOpts: MoleHttpListenOptions = {}): Promise<MoleHttpServer> {
  const host = listenOpts.host ?? '127.0.0.1';
  const isLoopback = LOOPBACK_HOSTS.has(host);

  if (!isLoopback && !(listenOpts.allowNonLoopback && listenOpts.bearerToken)) {
    throw new Error(
      `mole-mcp http: refusing to bind non-loopback host '${host}' without BOTH allowNonLoopback: true and a ` +
        'bearerToken set (this endpoint has no other auth layer by default -- see docs/mcp.md "remote HTTP ' +
        'mode"; MOLE_HTTP_ALLOW_NON_LOOPBACK=1 + MOLE_HTTP_BEARER_TOKEN in http-cli.ts)',
    );
  }

  const bearerToken = listenOpts.bearerToken;
  // Filled in once the real port is known (right after listen() resolves, below). Reassigning the binding
  // (not just mutating in place) is enough for the request handler closure to see the final values, since
  // no request can arrive before the `await new Promise(listen)` below settles.
  let allowedHosts: string[] = [];
  let allowedOrigins: string[] = [];

  const server = http.createServer((req, res) => {
    if (req.url !== '/mcp') {
      res.writeHead(404, { 'content-type': 'application/json' }).end(JSON.stringify({ error: 'not found' }));
      return;
    }
    if (bearerToken) {
      const expected = `Bearer ${bearerToken}`;
      if (!timingSafeStringEqual(req.headers.authorization ?? '', expected)) {
        res.writeHead(401, { 'content-type': 'application/json' }).end(JSON.stringify({ error: 'unauthorized' }));
        return;
      }
    }
    void (async () => {
      // A fresh McpServer per request (stateless mode): an McpServer can only be bound to one transport at
      // a time, so reusing one instance across concurrent requests would race. `createServer` is cheap --
      // it only registers tool handlers, it does not itself open the daemon connection (that happens lazily
      // per-tool-call via `ensureDaemon`/`MoleClient`, same as the stdio path).
      const mcp = createServer(opts);
      const transport = new StreamableHTTPServerTransport({
        sessionIdGenerator: undefined,
        enableDnsRebindingProtection: true,
        allowedHosts,
        allowedOrigins,
      });
      res.on('close', () => {
        void transport.close();
        void mcp.close();
      });
      await mcp.connect(transport);
      await transport.handleRequest(req, res);
    })().catch((err) => {
      if (!res.headersSent) res.writeHead(500, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ error: String(err instanceof Error ? err.message : err) }));
    });
  });

  await new Promise<void>((resolveListen, reject) => {
    server.once('error', reject);
    server.listen(listenOpts.port ?? 0, host, () => resolveListen());
  });

  const addr = server.address();
  const port = typeof addr === 'object' && addr ? addr.port : (listenOpts.port ?? 0);
  const bracketedHost = bracketIfIPv6(host);
  const url = `http://${bracketedHost}:${port}/mcp`;

  // The bound host/port, plus its localhost/127.0.0.1 aliases (a browser or MCP client may legitimately use
  // either name for a loopback server) -- anything else is DNS rebinding or a stray cross-origin request.
  // IPv6 literals are bracketed to match the Host/Origin headers a real client actually sends
  // (`[::1]:PORT`, `http://[::1]:PORT`), since an unbracketed `host:port` is ambiguous/invalid for IPv6.
  allowedHosts = Array.from(new Set([`${bracketedHost}:${port}`, `localhost:${port}`, `127.0.0.1:${port}`, `[::1]:${port}`]));
  allowedOrigins = Array.from(
    new Set([`http://${bracketedHost}:${port}`, `http://localhost:${port}`, `http://127.0.0.1:${port}`, `http://[::1]:${port}`]),
  );

  return {
    url,
    async close() {
      await new Promise<void>((resolveClose) => server.close(() => resolveClose()));
    },
  };
}
