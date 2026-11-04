// Local test OAuth issuer, standing in for a real OAuth 2.1 authorization server (R0
// prior-art.md §7 MCP spec 2025-06-18: servers MUST use OAuth2.1-issued bearer tokens on
// HTTP transports; non-goal: never a real OAuth provider). Tokens carry an `org` claim
// that becomes the RLS `app.current_org_id` scope for that MCP session (§6 + §7 combined).
import { SignJWT, jwtVerify } from 'jose';

export interface TestIssuer {
  mintToken(org: string, scopes?: string[]): Promise<string>;
  verifyToken(token: string): Promise<{ org: string; scopes: string[]; expiresAt?: number }>;
}

export function createTestIssuer(secret = 'mole-local-test-issuer-2026-10-29'): TestIssuer {
  const key = new TextEncoder().encode(secret);
  return {
    async mintToken(org, scopes = ['mole:read']) {
      return new SignJWT({ org, scopes })
        .setProtectedHeader({ alg: 'HS256' })
        .setIssuedAt()
        .setIssuer('mole-local-test-issuer')
        .setExpirationTime('10m')
        .sign(key);
    },
    async verifyToken(token) {
      const { payload } = await jwtVerify(token, key, { issuer: 'mole-local-test-issuer' });
      return { org: String(payload.org), scopes: (payload.scopes as string[]) ?? [], expiresAt: payload.exp };
    },
  };
}
