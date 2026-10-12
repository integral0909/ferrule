# LZ4 interop fixtures

Every `.lz4` file in this directory was produced by the **reference `lz4` CLI**
(<https://github.com/lz4/lz4>, built from `yann collet`'s reference implementation), not by this
package's own encoder — these are genuine third-party interop vectors, used by
`test/compression/lz4.test.ts` to prove `lz4Decompress` reads real LZ4 frames correctly (not just
frames this package wrote itself). The CLI used to generate them:

```
$ lz4 --version
*** lz4 v1.10.0 64-bit multithread, by Yann Collet ***
```

Each `.txt`/`.bin` file is the **original, uncompressed** input; the matching `.lz4` file is that
input compressed by the CLI. `lz4.test.ts` decompresses every `.lz4` file with this package's
`lz4Decompress` and asserts the result is byte-for-byte identical to its `.txt`/`.bin` counterpart.

## How each input was generated

```sh
# empty.txt — the empty-input edge case
printf '' > empty.txt

# hello.txt — a short, mostly-literal string (shorter than LZ4's 16-byte bulk-hash threshold)
printf 'Hello, Ferrule! This is a small test string for LZ4 interop.\n' > hello.txt

# repeated.txt — long and highly repetitive, to exercise long match copies
python3 -c "
line = 'the quick brown fox jumps over the lazy dog ' * 1
block = (line * 50 + chr(10)) * 40
import sys; sys.stdout.write(block)
" > repeated.txt

# random.bin — incompressible random bytes, to exercise the literal-only / no-match path
head -c 8192 /dev/urandom > random.bin

# multiblock.txt — large enough, with a small forced block size, to span multiple LZ4 blocks
python3 -c "
import random
random.seed(42)
words = ['alpha','beta','gamma','delta','epsilon','zeta','eta','theta','iota','kappa']
out = []
for i in range(20000):
    out.append(random.choice(words))
    if i % 12 == 0:
        out.append(str(i))
print(' '.join(out))
" > multiblock.txt
```

## How each `.lz4` file was generated

```sh
# Default settings: block-independent (CLI default), frame content checksum on, no block
# checksum, no content-size field.
lz4 -f -1 empty.txt empty.lz4
lz4 -f -1 hello.txt hello.lz4
lz4 -f -1 repeated.txt repeated.lz4
lz4 -f -1 random.bin random.lz4

# -B4 forces a 64KiB block max size (small enough that a 122,887-byte input spans several
# blocks); --content-size adds the optional 8-byte decompressed-size field to the frame header.
lz4 -f -1 -B4 --content-size multiblock.txt multiblock.lz4

# -BX turns on the optional per-block XXH32 checksum.
lz4 -f -1 -BX hello.txt hello_blockchecksum.lz4

# --no-frame-crc turns off the optional whole-content XXH32 checksum.
lz4 -f -1 --no-frame-crc repeated.txt repeated_nocrc.lz4
```

## What each fixture exercises

| File                      | FLG byte | Exercises                                                              |
| ------------------------- | -------- | ---------------------------------------------------------------------- |
| `empty.lz4`               | `0x64`   | Zero-length content; a frame with no blocks but a content checksum.    |
| `hello.lz4`               | `0x64`   | A single small block, default flags.                                   |
| `repeated.lz4`            | `0x64`   | A single large, highly compressible block (many long back-references). |
| `random.lz4`              | `0x64`   | A single incompressible block (literal-only, no matches at all).       |
| `multiblock.lz4`          | `0x6c`   | Several 64KiB blocks **and** the optional content-size field.          |
| `hello_blockchecksum.lz4` | `0x74`   | The optional per-block XXH32 checksum.                                 |
| `repeated_nocrc.lz4`      | `0x60`   | A frame with the optional content checksum turned **off**.             |

`empty.lz4`'s content checksum (the last 4 bytes of the file, `05 5d cc 02` little-endian =
`0x02cc5d05`) also happens to be `XXH32("", seed=0)`'s well-known published value — the simplest
possible independent check that this package's `xxhash32` implementation is correct, confirmed by
`test/compression/xxhash32.test.ts`. The other four non-trivial-length fixtures above (`hello`,
`repeated`, `random`, `multiblock`) give four more XXH32 digests computed by a completely
independent implementation (the `lz4` CLI's own) over real, non-trivial content — exercising both
the `>= 16`-byte bulk-hashing path and the short-input tail path — which `xxhash32.test.ts` also
checks against.

Bidirectional interop (this package's own `lz4Compress` output decompressed successfully by the
real `lz4` CLI) was verified by hand during development on the machine these fixtures were
generated on, but is not itself checked into a fixture file (there would be nothing for a
`vitest` run to shell out to on a machine without the `lz4` CLI installed) — the round-trip and
"never throws untyped" property tests in `lz4.test.ts` cover that direction instead, together with
the interop decode of these CLI-produced files.
