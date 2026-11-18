import type { ProduceBatch } from '../../../src/kafka/producer.js';

/** The idempotent-producer coordinates one RecordBatch of a {@link ProduceBatch} was stamped
 * with. Test-only: read off the batch's `@internal` partition groups so the package's public API
 * does not have to expose them. */
export interface StampedGroup {
  readonly topic: string;
  readonly partition: number;
  readonly producerId: bigint;
  readonly producerEpoch: number;
  readonly baseSequence: number;
  readonly recordCount: number;
}

interface InternalGroup {
  readonly topic: string;
  readonly partition: number;
  readonly records: readonly unknown[];
  readonly encoded:
    | { readonly producerId: bigint; readonly producerEpoch: number; readonly baseSequence: number }
    | undefined;
}

export function stampedGroups(batch: ProduceBatch): StampedGroup[] {
  const groups = (batch as unknown as { groups: readonly InternalGroup[] | undefined }).groups;
  return (groups ?? [])
    .filter((g) => g.encoded !== undefined)
    .map((g) => ({
      topic: g.topic,
      partition: g.partition,
      producerId: g.encoded!.producerId,
      producerEpoch: g.encoded!.producerEpoch,
      baseSequence: g.encoded!.baseSequence,
      recordCount: g.records.length,
    }));
}
