import { utf8Encode } from '@ferrule/core';
import { encodeVarint, zigZagEncode32, zigZagEncode64 } from '../varint.js';
import { WireType } from './reader.js';

/** A small growable byte sink used internally by {@link ProtoWriter}. */
class ByteSink {
  private buf: Uint8Array;
  private len = 0;

  constructor(initialCapacity = 256) {
    this.buf = new Uint8Array(Math.max(1, initialCapacity));
  }

  get length(): number {
    return this.len;
  }

  private ensure(extra: number): void {
    const needed = this.len + extra;
    if (needed <= this.buf.length) return;
    let capacity = this.buf.length * 2;
    while (capacity < needed) capacity *= 2;
    const next = new Uint8Array(capacity);
    next.set(this.buf.subarray(0, this.len));
    this.buf = next;
  }

  pushByte(b: number): void {
    this.ensure(1);
    this.buf[this.len++] = b & 0xff;
  }

  pushBytes(bytes: Uint8Array): void {
    this.ensure(bytes.length);
    this.buf.set(bytes, this.len);
    this.len += bytes.length;
  }

  toBytes(): Uint8Array {
    return this.buf.slice(0, this.len);
  }
}

/**
 * Builds a protobuf-encoded message by writing tagged fields in order. There is no requirement
 * that fields be written in field-number order (the wire format does not require it), but writing
 * in order matches what generated encoders typically produce and is easier to diff in tests.
 *
 * Nested (length-delimited) messages are written by fully encoding the child message first (with
 * a nested `ProtoWriter`) and then writing its known length followed by its bytes — size
 * precomputation, rather than reserving space and backpatching, which keeps this writer simple and
 * allocation-bounded per message.
 */
export class ProtoWriter {
  private readonly sink = new ByteSink();

  get length(): number {
    return this.sink.length;
  }

  private writeTag(field: number, wireType: WireType): void {
    this.sink.pushBytes(encodeVarint((field << 3) | wireType));
  }

  writeVarintField(field: number, value: bigint | number): void {
    this.writeTag(field, WireType.Varint);
    this.sink.pushBytes(encodeVarint(typeof value === 'number' ? BigInt(value) : value));
  }

  writeInt32(field: number, value: number): void {
    this.writeVarintField(field, BigInt.asUintN(64, BigInt(value)));
  }

  writeInt64(field: number, value: bigint): void {
    this.writeVarintField(field, BigInt.asUintN(64, value));
  }

  writeUInt32(field: number, value: number): void {
    this.writeVarintField(field, value >>> 0);
  }

  writeUInt64(field: number, value: bigint): void {
    this.writeVarintField(field, BigInt.asUintN(64, value));
  }

  writeBool(field: number, value: boolean): void {
    this.writeVarintField(field, value ? 1 : 0);
  }

  writeZigZag32(field: number, value: number): void {
    this.writeVarintField(field, zigZagEncode32(value));
  }

  writeZigZag64(field: number, value: bigint): void {
    this.writeVarintField(field, zigZagEncode64(value));
  }

  writeFixed32(field: number, value: number): void {
    this.writeTag(field, WireType.Fixed32);
    const v = value >>> 0;
    this.sink.pushByte(v & 0xff);
    this.sink.pushByte((v >>> 8) & 0xff);
    this.sink.pushByte((v >>> 16) & 0xff);
    this.sink.pushByte((v >>> 24) & 0xff);
  }

  writeSFixed32(field: number, value: number): void {
    this.writeFixed32(field, value | 0);
  }

  writeFixed64(field: number, value: bigint): void {
    this.writeTag(field, WireType.Fixed64);
    let v = BigInt.asUintN(64, value);
    for (let i = 0; i < 8; i++) {
      this.sink.pushByte(Number(v & 0xffn));
      v >>= 8n;
    }
  }

  writeSFixed64(field: number, value: bigint): void {
    this.writeFixed64(field, value);
  }

  writeFloat(field: number, value: number): void {
    const b = new Uint8Array(4);
    new DataView(b.buffer).setFloat32(0, value, true);
    this.writeTag(field, WireType.Fixed32);
    this.sink.pushBytes(b);
  }

  writeDouble(field: number, value: number): void {
    const b = new Uint8Array(8);
    new DataView(b.buffer).setFloat64(0, value, true);
    this.writeTag(field, WireType.Fixed64);
    this.sink.pushBytes(b);
  }

  writeBytes(field: number, value: Uint8Array): void {
    this.writeTag(field, WireType.LengthDelimited);
    this.sink.pushBytes(encodeVarint(value.length));
    this.sink.pushBytes(value);
  }

  writeString(field: number, value: string): void {
    this.writeBytes(field, utf8Encode(value));
  }

  /** Writes a nested message field, encoded by `build` against a fresh child writer. */
  writeMessage(field: number, build: (writer: ProtoWriter) => void): void {
    const child = new ProtoWriter();
    build(child);
    this.writeBytes(field, child.finish());
  }

  /** Writes a packed repeated scalar field: a single length-delimited field whose bytes are the
   * concatenation of each item's encoding (with no per-item tag). */
  writePacked<T>(
    field: number,
    items: readonly T[],
    writeItem: (writer: ProtoWriter, item: T) => void,
  ): void {
    if (items.length === 0) return;
    const child = new ProtoWriter();
    for (const item of items) writeItem(child, item);
    this.writeBytes(field, child.finish());
  }

  /** Appends raw, already-encoded bytes (used for a packed item writer, which has no tag of its own). */
  writeRaw(bytes: Uint8Array): void {
    this.sink.pushBytes(bytes);
  }

  writeRawVarint(value: bigint | number): void {
    this.sink.pushBytes(encodeVarint(typeof value === 'number' ? BigInt(value) : value));
  }

  writeRawFixed64(value: bigint): void {
    let v = BigInt.asUintN(64, value);
    for (let i = 0; i < 8; i++) {
      this.sink.pushByte(Number(v & 0xffn));
      v >>= 8n;
    }
  }

  writeRawDouble(value: number): void {
    const b = new Uint8Array(8);
    new DataView(b.buffer).setFloat64(0, value, true);
    this.sink.pushBytes(b);
  }

  finish(): Uint8Array {
    return this.sink.toBytes();
  }
}
