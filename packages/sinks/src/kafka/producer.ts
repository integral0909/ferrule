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

interface Assigned {
  readonly record: OutgoingRecord;
  readonly partition: number;
}

/**
 * A hand-written Kafka producer: broker connections (one per node, opened lazily), a metadata
 * cache (topic -> partition -> leader, refreshed on demand or after a stale-metadata error), the
 * default (murmur2) and sticky/round-robin partitioners, and `Produce` request constructions that
 * group records first by partition and then by the partition's leader broker, so one `send()`
 * call issues at most one `Produce` request per broker involved, regardless of how many
 * topic-partitions it touches. Idempotence is not implemented (not required by this sink): a
 * retry after a partial failure may resend records a partition already accepted, which is
 * consistent with the pipeline's documented at-least-once contract.
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

  /**
   * Sends `records`, grouped by partition and then by each partition's leader broker. Finishes
   * every record's event finalizer with the outcome of *its own* partition's response
   * (`delivered` on success, `rejected` on a permanent per-partition error); if any partition
   * reports a retryable error, throws a {@link KafkaError} without finishing those records'
   * events, so the caller's retry (with `runBatchedSink`'s toolkit) can resend them — a stale
   * topic's cached metadata is invalidated first, so the retry re-resolves the leader.
   */
  async send(records: readonly OutgoingRecord[]): Promise<void> {
    if (records.length === 0) return;
    const topics = [...new Set(records.map((r) => r.topic))];
    await this.ensureMetadata(topics);

    const assigned: Assigned[] = records.map((record) => ({
      record,
      partition: this.partitionFor(record.topic, record.key),
    }));
    for (const topic of topics) this.sticky.onBatchComplete(topic);

    // nodeId -> topic -> partition -> assigned records
    const byLeader = new Map<number, Map<string, Map<number, Assigned[]>>>();
    const leaderless: Assigned[] = [];
    for (const a of assigned) {
      const leaderId = this.topicLeaders.get(a.record.topic)?.get(a.partition);
      if (leaderId === undefined || leaderId < 0) {
        leaderless.push(a);
        continue;
      }
      let byTopic = byLeader.get(leaderId);
      if (byTopic === undefined) {
        byTopic = new Map();
        byLeader.set(leaderId, byTopic);
      }
      let byPartition = byTopic.get(a.record.topic);
      if (byPartition === undefined) {
        byPartition = new Map();
        byTopic.set(a.record.topic, byPartition);
      }
      const list = byPartition.get(a.partition);
      if (list === undefined) byPartition.set(a.partition, [a]);
      else list.push(a);
    }

    const retryableErrors: KafkaError[] = [];
    if (leaderless.length > 0) {
      for (const topic of new Set(leaderless.map((a) => a.record.topic))) {
        this.invalidateTopic(topic);
      }
      retryableErrors.push(new KafkaError(-1, 'no known leader for one or more partitions'));
    }

    await Promise.all(
      [...byLeader.entries()].map(([nodeId, byTopic]) =>
        this.sendToLeader(nodeId, byTopic, retryableErrors).catch((error: unknown) => {
          retryableErrors.push(
            error instanceof KafkaError ? error : new KafkaError(-1, String(error)),
          );
        }),
      ),
    );

    if (retryableErrors.length > 0) throw retryableErrors[0]!;
  }

  private invalidateTopic(topic: string): void {
    this.topicLeaders.delete(topic);
    this.partitionCounts.delete(topic);
  }

  private async sendToLeader(
    nodeId: number,
    byTopic: Map<string, Map<number, Assigned[]>>,
    retryableErrors: KafkaError[],
  ): Promise<void> {
    const addr = this.brokerAddresses.get(nodeId);
    if (addr === undefined) {
      throw new KafkaProtocolError(`no known address for broker node ${nodeId}`);
    }
    const conn = await this.getOrConnect(addr);

    const topicRequests: ProduceTopicRequest[] = [];
    const byKey = new Map<string, Assigned[]>();
    for (const [topic, byPartition] of byTopic) {
      const partitions: ProducePartitionRequest[] = [];
      for (const [partition, items] of byPartition) {
        const batch = encodeRecordBatch(
          items.map((a) => ({
            key: a.record.key,
            value: a.record.value,
            headers: a.record.headers,
            timestamp: a.record.timestamp,
          })),
          { compression: this.options.compression ?? 'none' },
        );
        partitions.push({ index: partition, records: batch });
        byKey.set(`${topic}\u0000${partition}`, items);
      }
      topicRequests.push({ name: topic, partitions });
    }

    const acks = this.options.acks ?? -1;
    const requestBody = encodeProduceRequestV9(
      topicRequests,
      acks,
      this.options.requestTimeoutMs ?? 30_000,
    );

    if (acks === 0) {
      await conn.sendOneWay(ApiKey.Produce, 9, true, requestBody);
      for (const items of byKey.values()) {
        for (const a of items) a.record.event.metadata.finalizers.finish('delivered');
      }
      return;
    }

    const responseBody = await conn.sendRequest(ApiKey.Produce, 9, true, requestBody);
    const response = decodeProduceResponseV9(responseBody);
    for (const topic of response.topics) {
      for (const partition of topic.partitions) {
        const items = byKey.get(`${topic.name}\u0000${partition.index}`) ?? [];
        if (partition.errorCode === 0) {
          for (const a of items) a.record.event.metadata.finalizers.finish('delivered');
          continue;
        }
        const error = new KafkaError(partition.errorCode, partition.errorMessage ?? undefined);
        if (error.needsMetadataRefresh) this.invalidateTopic(topic.name);
        if (error.isRetryable) {
          retryableErrors.push(error);
        } else {
          for (const a of items) a.record.event.metadata.finalizers.finish('rejected');
        }
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
