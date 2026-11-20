#!/usr/bin/env bash
# Regenerates the zstd interop fixtures with the *reference* zstd CLI, so the tests check our
# decoder against an encoder that is not libzstd-via-Node. Commit the outputs; tests never run
# this. Usage: ZSTD=/path/to/zstd ./generate.sh   (defaults to `zstd` on PATH)
set -euo pipefail
cd "$(dirname "$0")"
ZSTD="${ZSTD:-zstd}"
tmp="$(mktemp -d)"
trap 'rm -rf "$tmp"' EXIT

node --experimental-strip-types ../../support/log-lines.ts 25 1 >"$tmp/small.log"   # 7.6KB: one block
node --experimental-strip-types ../../support/log-lines.ts 1500 2 >"$tmp/large.log" # 455KB: four 128KB blocks
: >"$tmp/empty.log"

z() { "$ZSTD" -q -f "$@"; }
z -3 "$tmp/small.log" -o small-l3.zst                     # CLI default: content size + checksum
z -19 "$tmp/small.log" -o small-l19.zst                   # high level, different match finder
z -1 --no-check "$tmp/small.log" -o small-l1-nocheck.zst  # no content checksum
z -3 "$tmp/large.log" -o large-l3.zst
# Window (128KB) smaller than the input: not single-segment, so the header carries a
# Window_Descriptor *and* Frame_Content_Size -- the header-offset case in splitFrames().
z -3 --zstd=wlog=17 "$tmp/large.log" -o large-wlog17.zst
z -3 "$tmp/empty.log" -o empty.zst
# Read from a pipe, the CLI cannot know the size up front, so the frame omits Frame_Content_Size.
"$ZSTD" -q -3 -c <"$tmp/small.log" >small-stdin-nosize.zst
# Two frames back to back: legal zstd, and what `cat a.zst b.zst` produces.
"$ZSTD" -q -3 -c "$tmp/small.log" >two-frames.zst
"$ZSTD" -q -3 -c "$tmp/large.log" >>two-frames.zst

sha() { sha256sum "$1" | cut -d' ' -f1; }
size() { wc -c <"$1" | tr -d ' '; }
cat >manifest.json <<JSON
{
  "zstdCli": "$("$ZSTD" -V | sed -E 's/.*(v[0-9.]+).*/\1/')",
  "inputs": {
    "small": { "bytes": $(size "$tmp/small.log"), "sha256": "$(sha "$tmp/small.log")" },
    "large": { "bytes": $(size "$tmp/large.log"), "sha256": "$(sha "$tmp/large.log")" },
    "empty": { "bytes": 0, "sha256": "$(sha "$tmp/empty.log")" }
  }
}
JSON
echo "wrote fixtures with $("$ZSTD" -V)"
