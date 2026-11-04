// review-1 MED 3: read every blob in one `git cat-file --batch` call instead of one `git show`
// per file (69.5s -> target <10s on Mole's own repo). `git cat-file --batch` on stdin: feed one
// object id per line, read back `<sha> <type> <size>\n<size bytes of content>\n` per object
// (git-cat-file(1), "Batch Output", fetched 2026-11-03: https://git-scm.com/docs/git-cat-file).
// Binary-safe (raw Buffer, not execFile's utf8-decoded string) because the size-delimited framing
// must be read in bytes, not after a lossy string decode.
import { spawn } from 'node:child_process';

/** `shas` in request order; a missing object (should not happen for blobs from `git ls-tree`) is
 * simply absent from the returned map rather than throwing, so one bad entry doesn't fail the batch */
export function catFileBatch(root: string, shas: string[]): Promise<Map<string, Buffer>> {
  return new Promise((resolveP, reject) => {
    if (shas.length === 0) return resolveP(new Map());
    const proc = spawn('git', ['-C', root, '--no-optional-locks', 'cat-file', '--batch'], { stdio: ['pipe', 'pipe', 'pipe'] });
    const chunks: Buffer[] = [];
    let stderr = '';
    proc.stdout.on('data', (d: Buffer) => chunks.push(d));
    proc.stderr.on('data', (d: Buffer) => {
      stderr += d.toString();
    });
    proc.on('error', reject);
    proc.on('close', (code) => {
      if (code !== 0) {
        reject(new Error(`git cat-file --batch: ${stderr.trim() || `exit ${code}`}`));
        return;
      }
      const buf = Buffer.concat(chunks);
      const out = new Map<string, Buffer>();
      let pos = 0;
      while (pos < buf.length) {
        const nl = buf.indexOf(0x0a, pos);
        if (nl === -1) break;
        const header = buf.slice(pos, nl).toString('utf8');
        pos = nl + 1;
        const parts = header.split(' ');
        if (parts.length < 3) continue; // "<sha> missing" -- no content line follows
        const sha = parts[0]!;
        const size = Number(parts[2]);
        if (!Number.isFinite(size)) continue;
        out.set(sha, buf.slice(pos, pos + size));
        pos += size + 1; // skip the content and its trailing newline
      }
      resolveP(out);
    });
    proc.stdin.write(shas.join('\n') + '\n');
    proc.stdin.end();
  });
}
