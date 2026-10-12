import { KafkaReader, KafkaWriter } from './primitives.js';

/**
 * The "ConsumerProtocol" embedded schema (Apache Kafka's `ConsumerProtocolSubscription`/
 * `ConsumerProtocolAssignment`, see `clients/src/main/resources/common/message/`): the bytes
 * every group member puts in its `JoinGroup` request's `metadata` field (a subscription) and
 * that the coordinator relays back in `SyncGroup`'s `assignment` field. Unlike every other
 * message in `protocol.ts`, this is not a top-level Kafka request/response — it is opaque bytes
 * from the broker's point of view, so it uses the **classic**, non-flexible primitives
 * (`KafkaWriter.string`/`array`, not `compactString`/`compactArray`) at every version, matching
 * the real format: `Int16` version, then a sequence of fields gated by that version.
 *
 * This client implements versions 0 and 1 (`ownedPartitions`, needed by the cooperative-sticky
 * assignor's incremental revocation — see `assignors.ts`) and always writes version 1. Versions 2
 * (`generationId`) and 3 (`rackId`) exist in real Kafka but add nothing this client's assignors
 * use, so they are not implemented (an older broker-side consumer reading this client's
 * assignment, or vice versa, works fine either way: a reader only consumes the fields its own
 * version knows about).
 */

export interface ConsumerProtocolSubscription {
  readonly version: number;
  readonly topics: readonly string[];
  readonly userData: Buffer | null;
  /** Partitions this member believes it currently owns, grouped by topic — version 1+ only; an
   * empty array at version 0 (or when this member owns nothing yet, e.g. on its very first
   * join). Essential to the cooperative-sticky assignor: it is how each member tells the leader
   * what to preserve. */
  readonly ownedPartitions: readonly { readonly topic: string; readonly partitions: readonly number[] }[];
}

export function encodeConsumerProtocolSubscription(sub: ConsumerProtocolSubscription): Buffer {
  const w = new KafkaWriter();
  w.int16(sub.version);
  w.array(sub.topics, (writer, topic) => writer.string(topic));
  w.nullableBytes(sub.userData);
  if (sub.version >= 1) {
    w.array(sub.ownedPartitions, (writer, tp) => {
      writer.string(tp.topic);
      writer.array(tp.partitions, (pw, p) => pw.int32(p));
    });
  }
  return w.build();
}

export function decodeConsumerProtocolSubscription(buf: Buffer): ConsumerProtocolSubscription {
  const r = new KafkaReader(buf);
  const version = r.int16();
  const topicCount = r.arrayLength();
  const topics: string[] = [];
  for (let i = 0; i < topicCount; i++) topics.push(r.string());
  const userData = r.nullableBytes();
  const ownedPartitions: { topic: string; partitions: number[] }[] = [];
  if (version >= 1 && r.hasMore) {
    const tpCount = r.arrayLength();
    for (let i = 0; i < tpCount; i++) {
      const topic = r.string();
      const partitionCount = r.arrayLength();
      const partitions: number[] = [];
      for (let p = 0; p < partitionCount; p++) partitions.push(r.int32());
      ownedPartitions.push({ topic, partitions });
    }
  }
  return { version, topics, userData, ownedPartitions };
}

export interface ConsumerProtocolAssignment {
  readonly version: number;
  readonly partitions: readonly { readonly topic: string; readonly partitions: readonly number[] }[];
  readonly userData: Buffer | null;
}

export function encodeConsumerProtocolAssignment(assignment: ConsumerProtocolAssignment): Buffer {
  const w = new KafkaWriter();
  w.int16(assignment.version);
  w.array(assignment.partitions, (writer, tp) => {
    writer.string(tp.topic);
    writer.array(tp.partitions, (pw, p) => pw.int32(p));
  });
  w.nullableBytes(assignment.userData);
  return w.build();
}

export function decodeConsumerProtocolAssignment(buf: Buffer): ConsumerProtocolAssignment {
  const r = new KafkaReader(buf);
  const version = r.int16();
  const tpCount = r.arrayLength();
  const partitions: { topic: string; partitions: number[] }[] = [];
  for (let i = 0; i < tpCount; i++) {
    const topic = r.string();
    const partitionCount = r.arrayLength();
    const partitionList: number[] = [];
    for (let p = 0; p < partitionCount; p++) partitionList.push(r.int32());
    partitions.push({ topic, partitions: partitionList });
  }
  const userData = r.nullableBytes();
  return { version, partitions, userData };
}
