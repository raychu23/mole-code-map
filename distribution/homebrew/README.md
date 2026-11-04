## Summary
What: how to finish the Homebrew tap once `mole-code` has a real npm/release artifact. What's open: both
blockers below need the team.

## Two prerequisites, not done yet
1. `mole-code` needs an actual published npm tarball or a GitHub release asset (T85/T86 -- waiting on
   the team running `scripts/publish-all.sh` with his npm token, or at minimum tagging a GitHub release that
   attaches a built tarball as an asset).
2. A new repo `raychu23/homebrew-mole` (a "tap" -- Homebrew's convention for `brew tap <user>/<name>` to
   find `Formula/*.rb` outside homebrew-core) needs to exist under the team account. homebrew-core itself
   is not the right target for a brand-new tool: it has its own notability/maintenance bar (docs.brew.sh).

## Once both exist
1. Download the real tarball/asset, run `shasum -a 256 <file>` to get the real checksum.
2. Fill in `mole-code.rb`'s `url` and `sha256` (currently placeholders, clearly marked TODO).
3. Push `Formula/mole-code.rb` (this same file, just relocated) to `raychu23/homebrew-mole`.
4. Users then run: `brew tap raychu23/mole && brew install mole-code`.
5. Verify locally once filled in: `brew install --build-from-source --verbose --debug ./mole-code.rb` from a
   checkout of the tap repo (NOT RUN here -- no real artifact to point at yet, see prerequisite 1).
