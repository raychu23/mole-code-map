// HMAC-SHA256 verify for GitHub webhook deliveries (R0 prior-art.md §1: GitHub Docs
// "Validating webhook deliveries" — raw body, sha256= prefix, constant-time compare).
import crypto from 'node:crypto';

export function verifyGithubSignature(secret: string, rawBody: string, header: string | undefined): boolean {
  if (!header || !header.startsWith('sha256=')) return false;
  const theirHex = header.slice('sha256='.length);
  let theirs: Buffer;
  try {
    theirs = Buffer.from(theirHex, 'hex');
  } catch {
    return false;
  }
  const ours = crypto.createHmac('sha256', secret).update(rawBody, 'utf8').digest();
  if (theirs.length !== ours.length) return false;
  return crypto.timingSafeEqual(theirs, ours);
}
