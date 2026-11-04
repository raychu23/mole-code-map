# frozen_string_literal: true

# DRAFT formula. NOT a working tap yet: `url`/`sha256` below are placeholders because `mole-code` has no
# published npm tarball or tagged GitHub release ASSET yet (waiting on the maintainer's npm token,
# scripts/publish-all.sh). Fill both in once a real release exists, by running `shasum -a 256` against the
# actual downloaded tarball/release asset -- never guess or invent a checksum.
#
# Shape follows docs.brew.sh/Formula-Cookbook + the worked example at github.com/jaywcjlove/homebrew-tap
# (fetched 2026-11-04): a standalone tap repo (`raychu23/homebrew-mole`, not homebrew-core -- core has its own notability bar a brand-new tool doesn't meet yet) holding `Formula/
# mole-code.rb`. `depends_on "node"` because mole-code requires Node >= 22.13 (release/mole-code/README.md)
# and ships no native build step of its own (its own build already vendors better-sqlite3's prebuilt
# binary and bundles dependency-cruiser, see release/mole-code/README.md "How it is built").
class MoleCode < Formula
  desc "Visual codebase map + decisions-behind-the-code CLI/MCP server, following the file you open"
  homepage "https://github.com/raychu23/mole-code-map"
  # TODO: replace with the real tagged npm tarball URL once mole-code is published, e.g.
  # "https://registry.npmjs.org/mole-code/-/mole-code-0.1.0.tgz"
  url "https://registry.npmjs.org/mole-code/-/mole-code-0.1.0.tgz"
  sha256 "0000000000000000000000000000000000000000000000000000000000000" # TODO: real sha256, not a placeholder
  license "MIT"

  depends_on "node"

  def install
    system "npm", "install", *Language::Node.std_npm_install_args(libexec)
    bin.install_symlink Dir["#{libexec}/bin/*"]
  end

  test do
    system "#{bin}/mole", "--help"
  end
end
