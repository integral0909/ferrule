/**
 * Binary primitives for the Kafka wire protocol (see the "Protocol" pages on kafka.apache.org):
 * fixed-width integers, the classic length-prefixed string/bytes/array encodings used by older,
 * "non-flexible" API versions, and the "compact" (unsigned-varint-length-prefixed) string/array
 * encodings plus the empty tagged-fields terminator used by newer, "flexible" versions (KIP-482).
 *
 * The unsigned-LEB128 + zigzag varint scheme below is conceptually the same one `../varint.ts`
 * implements for protobuf in this package, but Kafka's `KafkaWriter`/`KafkaReader` need their own
 * small, Kafka-flavoured surface (`compactString`, `emptyTaggedFields`, classic vs. compact
 * variants side by side, ...) rather than `../varint.ts`'s lower-level, protobuf-shaped API, so it
 * is kept as its own self-contained implementation here instead of layered on top of it.
 */

const CONTINUATION = 0x80;
const PAYLOAD = 0x7f;

/** Encodes a non-negative integer as an unsigned LEB128 varint. */
function encodeUnsignedVarint(value: number | bigint): Buffer {
  let v = typeof value === 'bigint' ? value : BigInt(Math.trunc(value));
  if (v < 0n) {
    throw new RangeError(`cannot encode a negative value (${value}) as an unsigned varint`);
  }
  const bytes: number[] = [];
  do {
    let byte = Number(v & 0x7fn);
    v >>= 7n;
    if (v !== 0n) byte |= CONTINUATION;
    bytes.push(byte);
  } while (v !== 0n);
  return Buffer.from(bytes);
}

/** Reads an unsigned LEB128 varint starting at `offset`. Returns `[value, nextOffset]`. */
function readUnsignedVarint(buf: Buffer, offset: number): [bigint, number] {
  let result = 0n;
  let shift = 0n;
  for (let i = 0; i < 10; i++) {
    const pos = offset + i;
    if (pos >= buf.length) throw new RangeError('truncated Kafka varint');
    const byte = buf[pos]!;
    result |= BigInt(byte & PAYLOAD) << shift;
    if ((byte & CONTINUATION) === 0) return [BigInt.asUintN(64, result), pos + 1];
    shift += 7n;
  }
  throw new RangeError('Kafka varint longer than 10 bytes');
}

function zigZagEncode32(value: number): number {
  return ((value << 1) ^ (value >> 31)) >>> 0;
}

function zigZagDecode32(value: number): number {
  return (value >>> 1) ^ -(value & 1);
}

function zigZagEncode64(value: bigint): bigint {
  const v = BigInt.asIntN(64, value);
  return BigInt.asUintN(64, (v << 1n) ^ (v >> 63n));
}

function zigZagDecode64(value: bigint): bigint {
  const v = BigInt.asUintN(64, value);
  return BigInt.asIntN(64, (v >> 1n) ^ -(v & 1n));
}

export class KafkaWriter {
  private readonly chunks: Buffer[] = [];
  private length = 0;

  private push(buf: Buffer): this {
    this.chunks.push(buf);
    this.length += buf.length;
    return this;
  }

  get byteLength(): number {
    return this.length;
  }

  int8(value: number): this {
    return this.push(Buffer.from([value & 0xff]));
  }

  boolean(value: boolean): this {
    return this.int8(value ? 1 : 0);
  }

  int16(value: number): this {
    const b = Buffer.alloc(2);
    b.writeInt16BE(value, 0);
    return this.push(b);
  }

  int32(value: number): this {
    const b = Buffer.alloc(4);
    b.writeInt32BE(value, 0);
    return this.push(b);
  }

  uint32(value: number): this {
    const b = Buffer.alloc(4);
    b.writeUInt32BE(value >>> 0, 0);
    return this.push(b);
  }

  int64(value: bigint): this {
    const b = Buffer.alloc(8);
    b.writeBigInt64BE(BigInt.asIntN(64, value), 0);
    return this.push(b);
  }

  /** Unsigned LEB128 varint (used for compact string/array length prefixes: N+1, 0 = null). */
  varint(value: number): this {
    return this.push(encodeUnsignedVarint(value));
  }

  /** Zigzag-encoded signed varint (used for record-level `Int32` fields inside a RecordBatch). */
  zigzagVarint(value: number): this {
    return this.push(encodeUnsignedVarint(zigZagEncode32(value)));
  }

  /** Zigzag-encoded signed varlong (used for record-level `Int64` fields inside a RecordBatch). */
  zigzagVarlong(value: bigint): this {
    return this.push(encodeUnsignedVarint(zigZagEncode64(value)));
  }

  bytes(value: Uint8Array): this {
    return this.push(Buffer.from(value));
  }

  /** A classic (non-flexible) `INT16`-length-prefixed string. */
  string(value: string): this {
    const encoded = Buffer.from(value, 'utf8');
    return this.int16(encoded.length).bytes(encoded);
  }

  nullableString(value: string | null): this {
    if (value === null) return this.int16(-1);
    return this.string(value);
  }

  /** A classic (non-flexible) `INT32`-length-prefixed byte string; `-1` for null. */
  nullableBytes(value: Uint8Array | null): this {
    if (value === null) return this.int32(-1);
    return this.int32(value.length).bytes(value);
  }

  /** A "compact" (flexible-version) string: unsigned varint `length + 1`, then UTF-8 bytes. */
  compactString(value: string): this {
    const encoded = Buffer.from(value, 'utf8');
    return this.varint(encoded.length + 1).bytes(encoded);
  }

  compactNullableString(value: string | null): this {
    if (value === null) return this.varint(0);
    return this.compactString(value);
  }

  /** A "compact" (flexible-version) byte string: unsigned varint `length + 1`, then bytes. */
  compactNullableBytes(value: Uint8Array | null): this {
    if (value === null) return this.varint(0);
    return this.varint(value.length + 1).bytes(value);
  }

  /** A classic (non-flexible) `INT32`-length-prefixed array. */
  array<T>(items: readonly T[], writeItem: (writer: KafkaWriter, item: T) => void): this {
    this.int32(items.length);
    for (const item of items) writeItem(this, item);
    return this;
  }

  /** A "compact" (flexible-version) array: unsigned varint `length + 1`, then items; `null`
   * arrays (varint `0`) are not modelled since Kafka requests never need to send one. */
  compactArray<T>(items: readonly T[], writeItem: (writer: KafkaWriter, item: T) => void): this {
    this.varint(items.length + 1);
    for (const item of items) writeItem(this, item);
    return this;
  }

  /** The empty tagged-fields terminator every flexible-version struct ends with, since this
   * client never sends its own tagged fields. */
  emptyTaggedFields(): this {
    return this.varint(0);
  }

  build(): Buffer {
    return Buffer.concat(this.chunks, this.length);
  }
}

export class KafkaReader {
  private offset = 0;

  constructor(private readonly buf: Buffer) {}

  get remainingLength(): number {
    return this.buf.length - this.offset;
  }

  /** The number of bytes consumed so far (the current read position). */
  get position(): number {
    return this.offset;
  }

  get hasMore(): boolean {
    return this.offset < this.buf.length;
  }

  int8(): number {
    const v = this.buf.readInt8(this.offset);
    this.offset += 1;
    return v;
  }

  boolean(): boolean {
    return this.int8() !== 0;
  }

  int16(): number {
    const v = this.buf.readInt16BE(this.offset);
    this.offset += 2;
    return v;
  }

  int32(): number {
    const v = this.buf.readInt32BE(this.offset);
    this.offset += 4;
    return v;
  }

  uint32(): number {
    const v = this.buf.readUInt32BE(this.offset);
    this.offset += 4;
    return v;
  }

  int64(): bigint {
    const v = this.buf.readBigInt64BE(this.offset);
    this.offset += 8;
    return v;
  }

  varint(): number {
    const [value, next] = readUnsignedVarint(this.buf, this.offset);
    this.offset = next;
    return Number(value);
  }

  zigzagVarint(): number {
    return zigZagDecode32(this.varint());
  }

  zigzagVarlong(): bigint {
    const [value, next] = readUnsignedVarint(this.buf, this.offset);
    this.offset = next;
    return zigZagDecode64(value);
  }

  bytesRaw(n: number): Buffer {
    const b = Buffer.from(this.buf.subarray(this.offset, this.offset + n));
    this.offset += n;
    return b;
  }

  string(): string {
    const len = this.int16();
    return this.bytesRaw(len).toString('utf8');
  }

  nullableString(): string | null {
    const len = this.int16();
    if (len < 0) return null;
    return this.bytesRaw(len).toString('utf8');
  }

  nullableBytes(): Buffer | null {
    const len = this.int32();
    if (len < 0) return null;
    return this.bytesRaw(len);
  }

  compactString(): string {
    const len = this.varint() - 1;
    if (len < 0) throw new RangeError('expected a non-null compact string');
    return this.bytesRaw(len).toString('utf8');
  }

  compactNullableString(): string | null {
    const len = this.varint() - 1;
    if (len < 0) return null;
    return this.bytesRaw(len).toString('utf8');
  }

  compactNullableBytes(): Buffer | null {
    const len = this.varint() - 1;
    if (len < 0) return null;
    return this.bytesRaw(len);
  }

  /** The item count of a classic `INT32`-length-prefixed array. */
  arrayLength(): number {
    return this.int32();
  }

  /** The item count of a "compact" array (already `- 1`'d). */
  compactArrayLength(): number {
    return this.varint() - 1;
  }

  /** Skips a flexible-version struct's trailing tagged-fields section (this client never needs
   * to interpret tagged fields it did not itself request). */
  skipTaggedFields(): void {
    const count = this.varint();
    for (let i = 0; i < count; i++) {
      this.varint(); // tag
      const size = this.varint();
      this.offset += size;
    }
  }

  rest(): Buffer {
    return this.bytesRaw(this.remainingLength);
  }
}
