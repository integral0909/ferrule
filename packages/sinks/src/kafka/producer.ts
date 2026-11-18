import type { Event } from '@ferrule/core';
import type { TlsOptions } from '../fragments.js';
import { KafkaBrokerConnection } from './connection.js';
import { KafkaError, KafkaProtocolError } from './errors.js';
import { murmur2Partition, RoundRobinPartitioner, StickyPartitioner } from './murmur2.js';
import { encodeRecordBatch, type CompressionType, type RecordHeaderInput } from './record-batch.js';
import {
  ApiKey,
  decodeMetadataResponseV9,
  decodeProduceResponseV9,
  encodeMetadataRequestV9,
  encodeProduceRequestV9,
  type ProducePartitionRequest,
  type ProduceTopicRequest,
} from './protocol.js';
import type { KafkaSaslOptions } from './sasl.js';

export interface BrokerAddress {
  readonly host: string;
  readonly port: number;
}

export interface KafkaProducerOptions {
  readonly bootstrapBrokers: readonly BrokerAddress[];
  readonly clientId?: string;
  readonly tls?: TlsOptions;
  readonly sasl?: KafkaSaslOptions;
  readonly connectTimeoutMs?: number;
  readonly maxInFlightRequestsPerConnection?: number;
  readonly acks?: -1 | 0 | 1;
  readonly requestTimeoutMs?: number;
  readonly compression?: CompressionType;
  /** Partition strategy for records with no key. Keyed records always use the murmur2 default
   * partitioner (matching the classic Java client). Default `sticky`. */
  readonly partitioner?: 'round_robin' | 'sticky';
}

export interface OutgoingRecord {
  readonly topic: string;
  readonly key: Uint8Array | null;
  readonly value: Uint8Array | null;
  readonly headers: readonly RecordHeaderInput[];
  readonly timestamp: bigint;
  /** The event this record was produced from, finished by {@link KafkaProducer.send} directly
   * with the outcome of *its own* partition's response — not by the caller. */
  readonly event: Event;
}

/** The records of one batch bound for one topic-partition, settled together by that partition's
 * response. */
interface PartitionGroup {
  readonly topic: string;
  readonly partition: number;
  readonly records: readonly OutgoingRecord[];
  /** Set once the partition has answered conclusively (accepted, or a permanent error): the group
   * is never sent again. */
  settled: boolean;
}

/**
 * A set of records handed to {@link KafkaProducer.send} together, kept across retries. Partition
 * assignment happens on the first `send` and is then fixed, so every retry targets the same
 * partitions; groups the broker has already accepted (or permanently rejected) are marked settled
 * and excluded from later sends of the same batch.
 */
export class ProduceBatch {
  /** @internal Filled on the first `send`, once partition metadata is known. */
  groups: PartitionGroup[] | undefined;

  constructor(readonly records: readonly OutgoingRecord[]) {}

  /** Records not yet accepted or permanently rejected (all of them before the first `send`). */
  get pending(): readonly OutgoingRecord[] {
    if (this.groups === undefined) return this.records;
    return this.groups.filter((g) => !g.settled).flatMap((g) => g.records);
  }
}

/**
 * A hand-written Kafka producer: broker connections (one per node, opened lazily), a metadata
 * cache (topic -> partition -> leader, refreshed on demand or after a stale-metadata error), the
 * default (murmur2) and sticky/round-robin partitioners, and `Produce` request constructions that
 * group records first by partition and then by the partition's leader broker, so one round issues
 * at most one `Produce` request per broker involved, regardless of how many topic-partitions it
 * touches.
 *
 * The unit of retry is a {@link ProduceBatch}: `send` settles each topic-partition group of the
 * batch independently as its own response arrives, and a later `send` of the same batch (the
 * caller's retry) only resends the groups that are still unsettled, so a partition that already
 * accepted its records is never asked to append them again because a sibling partition failed.
 */
export class KafkaProducer {
  private readonly connections = new Map<string, KafkaBrokerConnection>();
  private readonly bootstrapAddrs: BrokerAddress[];
  private bootstrapIndex = 0;
  private readonly topicLeaders = new Map<string, Map<number, number>>(); // topic -> partition -> nodeId
  private readonly partitionCounts = new Map<string, number>();
  private readonly brokerAddresses = new Map<number, BrokerAddress>();
  private readonly roundRobin = new RoundRobinPartitioner();
  private readonly sticky = new StickyPartitioner();

  constructor(private readonly options: KafkaProducerOptions) {
    if (options.bootstrapBrokers.length === 0) {
      throw new KafkaProtocolError('at least one bootstrap broker is required');
    }
    this.bootstrapAddrs = [...options.bootstrapBrokers];
  }

  private async getOrConnect(addr: BrokerAddress): Promise<KafkaBrokerConnection> {
    const key = `${addr.host}:${addr.port}`;
    const existing = this.connections.get(key);
    if (existing !== undefined && !existing.isClosed) return existing;
    const conn = new KafkaBrokerConnection({
      host: addr.host,
      port: addr.port,
      ...(this.options.clientId !== undefined ? { clientId: this.options.clientId } : {}),
      ...(this.options.tls !== undefined ? { tls: this.options.tls } : {}),
      ...(this.options.sasl !== undefined ? { sasl: this.options.sasl } : {}),
      ...(this.options.connectTimeoutMs !== undefined
        ? { connectTimeoutMs: this.options.connectTimeoutMs }
        : {}),
      maxInFlightRequests: this.options.maxInFlightRequestsPerConnection ?? 5,
    });
    await conn.connect();
    this.connections.set(key, conn);
    return conn;
  }

  private nextBootstrap(): BrokerAddress {
    const addr = this.bootstrapAddrs[this.bootstrapIndex % this.bootstrapAddrs.length]!;
    this.bootstrapIndex++;
    return addr;
  }

  /** Fetches (and caches) leader metadata for `topics`. Tries every bootstrap broker in turn
   * before giving up, since any one of them can answer a Metadata request for any topic. */
  async refreshMetadata(topics: readonly string[]): Promise<void> {
    if (topics.length === 0) return;
    let lastError: unknown;
    for (let attempt = 0; attempt < this.bootstrapAddrs.length; attempt++) {
      const addr = this.nextBootstrap();
      try {
        const conn = await this.getOrConnect(addr);
        const body = await conn.sendRequest(
          ApiKey.Metadata,
          9,
          true,
          encodeMetadataRequestV9(topics, true),
        );
        const response = decodeMetadataResponseV9(body);
        for (const broker of response.brokers) {
          this.brokerAddresses.set(broker.nodeId, { host: broker.host, port: broker.port });
        }
        for (const topic of response.topics) {
          if (topic.name === null) continue;
          if (topic.errorCode !== 0) {
            lastError = new KafkaError(topic.errorCode, `metadata error for topic ${topic.name}`);
            continue;
          }
          const leaders = new Map<number, number>();
          for (const partition of topic.partitions) {
            leaders.set(partition.partitionIndex, partition.leaderId);
          }
          this.topicLeaders.set(topic.name, leaders);
          this.partitionCounts.set(topic.name, topic.partitions.length);
        }
        return;
      } catch (error) {
        lastError = error;
      }
    }
    throw lastError instanceof Error
      ? lastError
      : new KafkaProtocolError('failed to fetch Kafka metadata');
  }

  private async ensureMetadata(topics: readonly string[]): Promise<void> {
    const missing = topics.filter((t) => !this.topicLeaders.has(t));
    if (missing.length > 0) await this.refreshMetadata(missing);
  }

  private partitionFor(topic: string, key: Uint8Array | null): number {
    const count = this.partitionCounts.get(topic);
    if (count === undefined || count === 0) {
      throw new KafkaProtocolError(
        `no partition metadata available for topic ${JSON.stringify(topic)}`,
      );
    }
    if (key !== null) return murmur2Partition(key, count);
    return this.options.partitioner === 'round_robin'
      ? this.roundRobin.next(topic, count)
      : this.sticky.next(topic, count);
  }

  /** Wraps `records` in a {@link ProduceBatch} without sending anything. */
  prepare(records: readonly OutgoingRecord[]): ProduceBatch {
    return new ProduceBatch(records);
  }

  /**
   * Sends every unsettled group of `batch`, grouped by each partition's leader broker, and
   * finishes each record's event finalizer with the outcome of *its own* partition's response
   * (`delivered` on success, `rejected` on a permanent per-partition error). If any group's
   * partition reports a retryable error (or its leader is unknown or unreachable), throws a
   * {@link KafkaError} without finishing or settling those records' events; a stale topic's cached
   * metadata is invalidated first, so the caller's retry — `send` again with the *same* batch —
   * re-resolves the leader and resends only what is still unsettled.
   *
   * A plain array is accepted for one-shot sends with no retry; each such call is a new batch.
   */
  async send(input: ProduceBatch | readonly OutgoingRecord[]): Promise<void> {
    const batch = input instanceof ProduceBatch ? input : new ProduceBatch(input);
    if (batch.records.length === 0) return;
    if (batch.groups === undefined) batch.groups = await this.assignPartitions(batch.records);

    const unsettled = batch.groups.filter((g) => !g.settled);
    if (unsettled.length === 0) return;
    await this.ensureMetadata([...new Set(unsettled.map((g) => g.topic))]);

    const byLeader = new Map<number, PartitionGroup[]>();
    const leaderless: PartitionGroup[] = [];
    for (const group of unsettled) {
      const leaderId = this.topicLeaders.get(group.topic)?.get(group.partition);
      if (leaderId === undefined || leaderId < 0) {
        leaderless.push(group);
        continue;
      }
      const list = byLeader.get(leaderId);
      if (list === undefined) byLeader.set(leaderId, [group]);
      else list.push(group);
    }

    const retryableErrors: KafkaError[] = [];
    if (leaderless.length > 0) {
      for (const topic of new Set(leaderless.map((g) => g.topic))) this.invalidateTopic(topic);
      retryableErrors.push(new KafkaError(-1, 'no known leader for one or more partitions'));
    }

    await Promise.all(
      [...byLeader.entries()].map(([nodeId, groups]) =>
        this.sendToLeader(nodeId, groups, retryableErrors).catch((error: unknown) => {
          retryableErrors.push(
            error instanceof KafkaError ? error : new KafkaError(-1, String(error)),
          );
        }),
      ),
    );

    if (retryableErrors.length > 0) throw retryableErrors[0]!;
  }

  /** Resolves every record's partition (fetching metadata first if needed) and groups the records
   * by topic-partition, preserving their relative order within each group. */
  private async assignPartitions(records: readonly OutgoingRecord[]): Promise<PartitionGroup[]> {
    const topics = [...new Set(records.map((r) => r.topic))];
    await this.ensureMetadata(topics);
    const groups = new Map<
      string,
      { topic: string; partition: number; records: OutgoingRecord[] }
    >();
    for (const record of records) {
      const partition = this.partitionFor(record.topic, record.key);
      const key = `${record.topic}\u0000${partition}`;
      const group = groups.get(key);
      if (group === undefined)
        groups.set(key, { topic: record.topic, partition, records: [record] });
      else group.records.push(record);
    }
    for (const topic of topics) this.sticky.onBatchComplete(topic);
    return [...groups.values()].map((g) => ({ ...g, settled: false }));
  }

  private invalidateTopic(topic: string): void {
    this.topicLeaders.delete(topic);
    this.partitionCounts.delete(topic);
  }

  private settle(group: PartitionGroup, status: 'delivered' | 'rejected'): void {
    group.settled = true;
    for (const record of group.records) record.event.metadata.finalizers.finish(status);
  }

  private async sendToLeader(
    nodeId: number,
    groups: readonly PartitionGroup[],
    retryableErrors: KafkaError[],
  ): Promise<void> {
    const addr = this.brokerAddresses.get(nodeId);
    if (addr === undefined) {
      throw new KafkaProtocolError(`no known address for broker node ${nodeId}`);
    }
    const conn = await this.getOrConnect(addr);

    const byTopic = new Map<string, ProducePartitionRequest[]>();
    const byKey = new Map<string, PartitionGroup>();
    for (const group of groups) {
      const batch = encodeRecordBatch(
        group.records.map((r) => ({
          key: r.key,
          value: r.value,
          headers: r.headers,
          timestamp: r.timestamp,
        })),
        { compression: this.options.compression ?? 'none' },
      );
      const partitions = byTopic.get(group.topic);
      const request = { index: group.partition, records: batch };
      if (partitions === undefined) byTopic.set(group.topic, [request]);
      else partitions.push(request);
      byKey.set(`${group.topic}\u0000${group.partition}`, group);
    }
    const topicRequests: ProduceTopicRequest[] = [...byTopic.entries()].map(
      ([name, partitions]) => ({ name, partitions }),
    );

    const acks = this.options.acks ?? -1;
    const requestBody = encodeProduceRequestV9(
      topicRequests,
      acks,
      this.options.requestTimeoutMs ?? 30_000,
    );

    if (acks === 0) {
      await conn.sendOneWay(ApiKey.Produce, 9, true, requestBody);
      for (const group of groups) this.settle(group, 'delivered');
      return;
    }

    const responseBody = await conn.sendRequest(ApiKey.Produce, 9, true, requestBody);
    const response = decodeProduceResponseV9(responseBody);
    for (const topic of response.topics) {
      for (const partition of topic.partitions) {
        const group = byKey.get(`${topic.name}\u0000${partition.index}`);
        if (group === undefined) continue;
        if (partition.errorCode === 0) {
          this.settle(group, 'delivered');
          continue;
        }
        const error = new KafkaError(partition.errorCode, partition.errorMessage ?? undefined);
        if (error.needsMetadataRefresh) this.invalidateTopic(topic.name);
        if (error.isRetryable) retryableErrors.push(error);
        else this.settle(group, 'rejected');
      }
    }
  }

  /** Connects to any one reachable bootstrap broker and asks its supported API versions, as a
   * lightweight connectivity check. */
  async healthcheck(): Promise<void> {
    let lastError: unknown;
    for (let attempt = 0; attempt < this.bootstrapAddrs.length; attempt++) {
      const addr = this.nextBootstrap();
      try {
        const conn = await this.getOrConnect(addr);
        await conn.apiVersions();
        return;
      } catch (error) {
        lastError = error;
      }
    }
    throw lastError instanceof Error
      ? lastError
      : new KafkaProtocolError('failed to reach any bootstrap broker');
  }

  async close(): Promise<void> {
    await Promise.all([...this.connections.values()].map((c) => c.close()));
    this.connections.clear();
  }
}
