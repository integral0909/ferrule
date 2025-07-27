import { LimitExceededError, ParseError, utf8Decode } from '@ferrule/core';
import { tryReadVarint, zigZagDecode32, zigZagDecode64 } from '../varint.js';

/** Protobuf wire types, as encoded in the low 3 bits of every field tag. */
export const enum WireType {
  Varint = 0,
  Fixed64 = 1,
  LengthDelimited = 2,
  StartGroup = 3,
  EndGroup = 4,
  Fixed32 = 5,
}

const MAX_WIRE_TYPE = 5;

export interface ProtoReaderOptions {
  /** Maximum nesting depth for {@link ProtoReader.subReader} and group skipping. Default 64. */
  maxDepth?: number;
}

function protoError(message: string, offset?: number): never {
  throw new ParseError('E_PROTO_SYNTAX', message, offset);
}

/**
 * A cursor over a protobuf-encoded byte buffer. Callers drive decoding by reading a tag with
 * {@link readTag}, dispatching on the field number, and either reading the field with the
 * matching typed accessor or calling {@link skipValue} for fields they do not recognise.
 *
 * There is deliberately no generated or reflective message decoding: every OTLP message type in
 * `../otlp` is decoded by a small hand-written loop over `ProtoReader`.
 */
export class ProtoReader {
  private readonly buf: Uint8Array;
  private pos: number;
  private readonly end: number;
  readonly maxDepth: number;
  readonly depth: number;

  constructor(buf: Uint8Array, options: ProtoReaderOptions & { depth?: number } = {}) {
    this.buf = buf;
    this.pos = 0;
    this.end = buf.length;
    this.maxDepth = options.maxDepth ?? 64;
    this.depth = options.depth ?? 0;
    if (this.depth > this.maxDepth) {
      throw new LimitExceededError(
        'proto.depth',
        this.maxDepth,
        'protobuf message nesting too deep',
      );
    }
  }

  get position(): number {
    return this.pos;
  }

  get remaining(): number {
    return this.end - this.pos;
  }

  atEnd(): boolean {
    return this.pos >= this.end;
  }

  private requireByte(): number {
    if (this.pos >= this.end) protoError('unexpected end of protobuf message', this.pos);
    return this.buf[this.pos++]!;
  }

  private requireBytes(n: number): Uint8Array {
    if (this.pos + n > this.end) {
      protoError(`expected ${n} more byte(s) but only ${this.end - this.pos} remain`, this.pos);
    }
    const slice = this.buf.subarray(this.pos, this.pos + n);
    this.pos += n;
    return slice;
  }

  /** Reads a raw tag varint and splits it into a field number and wire type. */
  readTag(): { field: number; wireType: WireType } {
    const raw = this.readUInt32();
    const wireType = raw & 0x7;
    if (wireType > MAX_WIRE_TYPE) protoError(`invalid wire type ${wireType}`, this.pos);
    return { field: raw >>> 3, wireType };
  }

  /** Reads a raw unsigned varint (up to 64 bits). */
  readVarint(): bigint {
    const result = tryReadVarint(this.buf, this.pos, Math.min(10, this.end - this.pos + 1));
    if (result === undefined) protoError('truncated varint', this.pos);
    this.pos = result.next;
    return result.value;
  }

  /** Reads a varint and interprets it as an unsigned (`uint32`/`bool`/enum) value. */
  readUInt32(): number {
    const v = this.readVarint();
    return Number(BigInt.asUintN(32, v));
  }

  readUInt64(): bigint {
    return this.readVarint();
  }

  /** Reads a varint and interprets it as a proto `int32` (sign-extended from the low 32 bits). */
  readInt32(): number {
    const v = this.readVarint();
    return Number(BigInt.asIntN(32, v));
  }

  /** Reads a varint and interprets it as a proto `int64`. */
  readInt64(): bigint {
    return BigInt.asIntN(64, this.readVarint());
  }

  readBool(): boolean {
    return this.readVarint() !== 0n;
  }

  readZigZag32(): number {
    return zigZagDecode32(this.readUInt32());
  }

  readZigZag64(): bigint {
    return zigZagDecode64(this.readVarint());
  }

  readFixed32(): number {
    const b = this.requireBytes(4);
    return (b[0]! | (b[1]! << 8) | (b[2]! << 16) | (b[3]! << 24)) >>> 0;
  }

  readSFixed32(): number {
    return this.readFixed32() | 0;
  }

  readFixed64(): bigint {
    const b = this.requireBytes(8);
    let v = 0n;
    for (let i = 7; i >= 0; i--) v = (v << 8n) | BigInt(b[i]!);
    return v;
  }

  readSFixed64(): bigint {
    return BigInt.asIntN(64, this.readFixed64());
  }

  readFloat(): number {
    const b = this.requireBytes(4);
    return new DataView(b.buffer, b.byteOffset, 4).getFloat32(0, true);
  }

  readDouble(): number {
    const b = this.requireBytes(8);
    return new DataView(b.buffer, b.byteOffset, 8).getFloat64(0, true);
  }

  /** Reads a length-delimited field's raw bytes (used for `bytes`, `string`, and submessages). */
  readBytes(): Uint8Array {
    const len = this.readVarint();
    if (len > BigInt(this.remaining)) {
      protoError(
        `length-delimited field declares ${len} byte(s) but only ${this.remaining} remain`,
        this.pos,
      );
    }
    return this.requireBytes(Number(len));
  }

  readString(): string {
    return utf8Decode(this.readBytes(), 'lossy');
  }

  /** Reads a length-delimited submessage and returns a reader over just its bytes, one nesting
   * level deeper (enforcing `maxDepth`). */
  subReader(): ProtoReader {
    return new ProtoReader(this.readBytes(), { maxDepth: this.maxDepth, depth: this.depth + 1 });
  }

  /**
   * Reads a length-delimited field and decodes it as a packed repeated scalar: `itemReader` is
   * called repeatedly against a reader scoped to the field's bytes until they are exhausted.
   */
  readPacked<T>(itemReader: (r: ProtoReader) => T): T[] {
    const inner = this.subReader();
    const items: T[] = [];
    while (!inner.atEnd()) items.push(itemReader(inner));
    return items;
  }

  /**
   * Skips the value of a field with the given wire type, having already consumed its tag. Groups
   * (deprecated wire types 3/4) are skipped recursively, honouring `maxDepth`.
   */
  skipValue(wireType: WireType): void {
    switch (wireType) {
      case WireType.Varint:
        this.readVarint();
        return;
      case WireType.Fixed64:
        this.requireBytes(8);
        return;
      case WireType.LengthDelimited:
        this.readBytes();
        return;
      case WireType.Fixed32:
        this.requireBytes(4);
        return;
      case WireType.StartGroup:
        this.skipGroup(this.depth + 1);
        return;
      case WireType.EndGroup:
        protoError('unexpected end-group marker', this.pos);
    }
  }

  private skipGroup(groupDepth: number): void {
    if (groupDepth > this.maxDepth) {
      throw new LimitExceededError('proto.depth', this.maxDepth, 'protobuf group nesting too deep');
    }
    for (;;) {
      if (this.atEnd()) protoError('unterminated group', this.pos);
      const { wireType } = this.readTag();
      if (wireType === WireType.EndGroup) return;
      if (wireType === WireType.StartGroup) this.skipGroup(groupDepth + 1);
      else this.skipValue(wireType);
    }
  }

  /** Requires the message to be fully consumed; throws otherwise. Useful for top-level requests. */
  requireEnd(): void {
    if (!this.atEnd()) {
      protoError(`unexpected trailing bytes after message (${this.remaining} left)`, this.pos);
    }
  }
}

/** Iterates every top-level field of `buf`, calling `visit` with the field number, wire type, and
 * a reader positioned to read that field's value. Unread fields (where `visit` neither reads nor
 * skips) are skipped automatically. */
export function forEachField(
  buf: Uint8Array,
  visit: (field: number, wireType: WireType, reader: ProtoReader) => void,
  options?: ProtoReaderOptions,
): void {
  const reader = new ProtoReader(buf, options);
  while (!reader.atEnd()) {
    const { field, wireType } = reader.readTag();
    const before = reader.position;
    visit(field, wireType, reader);
    if (reader.position === before) reader.skipValue(wireType);
  }
}
