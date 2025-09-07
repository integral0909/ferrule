/**
 * CRC-32C (Castagnoli), the checksum used to protect every record written to a segment file
 * (see `FORMAT.md`). CRC-32C is preferred over the classic CRC-32 (Ethernet/zlib) polynomial
 * because it has substantially better error-detection properties for the burst lengths typical
 * of torn writes, and hardware acceleration (SSE4.2 `CRC32` instructions) is common, though this
 * implementation is a portable, table-driven software version with no native dependency.
 *
 * Polynomial (reflected form): `0x82F63B78`, corresponding to the normal-form polynomial
 * `0x1EDC6F41` used by iSCSI, ext4, and Btrfs.
 */

const POLYNOMIAL = 0x82f63b78;

/** Precomputed lookup table: `TABLE[i]` is the CRC-32C update for a single byte `i`. */
const TABLE = buildTable();

function buildTable(): Uint32Array {
  const table = new Uint32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) {
      c = (c & 1) !== 0 ? POLYNOMIAL ^ (c >>> 1) : c >>> 1;
    }
    table[n] = c >>> 0;
  }
  return table;
}

/**
 * Computes the CRC-32C of `data`, optionally continuing from a previous checksum.
 *
 * To checksum data assembled from several pieces without concatenating them, chain calls:
 * `crc32c(partB, crc32c(partA))` equals `crc32c(concat(partA, partB))`. The `seed` parameter
 * takes the previously *finalized* checksum (not raw internal CRC state), so chaining composes
 * naturally without exposing an internal representation.
 */
export function crc32c(data: Uint8Array, seed = 0): number {
  let crc = (seed ^ 0xffffffff) >>> 0;
  for (let i = 0; i < data.length; i++) {
    crc = (TABLE[(crc ^ data[i]!) & 0xff]! ^ (crc >>> 8)) >>> 0;
  }
  return (crc ^ 0xffffffff) >>> 0;
}
