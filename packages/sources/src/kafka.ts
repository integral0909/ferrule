/**
 * `kafka`: consumes from one or more topics via `@ferrule/codecs`'s hand-written consumer group
 * client, decodes each record's value with a configurable codec, and annotates every decoded
 * event with the record's key, headers, topic, partition, and offset as metadata fields.
 *
 * Design notes (why it's built this way — mirrors `file.ts`'s own design notes for the same
 * problem in a different medium):
 *
 * - **Offsets are committed only for the contiguous prefix of acknowledged records per
 *   partition**, exactly like the `file` source's checkpoints track an ordered queue of
 *   outstanding ranges per file rather than one scalar watermark. Each poll's fetched batch for
 *   a partition is sent downstream immediately and queued as a `'pending'` range rather than
 *   awaited inline — one partition's slow or stuck acknowledgement can't hold up another
 *   partition's progress. The *committed* offset only ever advances over the contiguous prefix of
 *   that partition's queue that has resolved to something other than `'errored'`: a batch that
 *   resolves `'errored'` is left in place at the head of the queue, permanently blocking that
 *   partition's committed offset from advancing past it for the rest of this run — a restart (or
 *   a rebalance to another member) re-fetches from the last committed offset, redelivering it.
 *   This is the at-least-once contract the rest of the pipeline expects from a source: never lose
 *   an acknowledged-pending record, at the cost of possibly redelivering one that was in flight
 *   but unacknowledged when the process stopped or the partition moved.
 * - **Backpressure pauses fetching per partition.** Once a partition's outstanding queue reaches
 *   `max_outstanding_batches`, it is excluded from this consumer's next `Fetch` (via
 *   `KafkaConsumer.pausePartitions`) until an outstanding batch resolves, bounding memory without
 *   slowing down any other partition (including other partitions of the same topic) that is
 *   still keeping up.
 * - **A revoked partition's acknowledged prefix is committed before it's released.** The
 *   consumer's `onRebalance` callback is awaited before it fetches newly-assigned partitions (see
 *   `@ferrule/codecs`'s own docs), so this is the one safe place to do it: for each revoked
 *   partition, fetching already stopped (the consumer excludes it from `poll()` before this
 *   callback fires), so this waits — bounded by `rebalance_commit_timeout`, since a partition
 *   might have deliveries that never resolve (down a dead output) — for its outstanding batches
 *   to resolve, commits whatever contiguous prefix that leaves acknowledged, and drops the
 *   partition's local tracking state. Acknowledgements off: a batch is queued already-resolved
 *   (`'delivered'`), so its offset is committed as soon as it's sent downstream, same as the
 *   `file` source's behaviour with acknowledgements disabled.
 * - **`topics` and `topic_pattern` are resolved once, at startup**, not re-evaluated while
 *   running: `topic_pattern` is matched against the cluster's topic list (discovered via a
 *   `Metadata(topics: null)` request) once, before the consumer group client is constructed,
 *   since `KafkaConsumer` does not support changing a running member's subscription. A topic
 *   created later that matches the pattern is picked up only after this source restarts.
 * - **A partition with no committed offset, or whose committed offset the broker reports
 *   `OFFSET_OUT_OF_RANGE`, is positioned via `auto_offset_reset`** (`earliest` or `latest`,
 *   default `latest` — a fresh consumer group joining an existing, possibly large topic should
 *   not have to replay its entire history by default, matching the real Kafka consumer's own
 *   default for this exact scenario), resolved against the partition's actual log bounds with
 *   `ListOffsets` rather than assumed to be `0`.
 */
import {
  ApiKey,
  decodeMetadataResponseV9,
  defaultCodecs,
  encodeMetadataRequestV9,
  KafkaBrokerConnection,
  KafkaConsumer,
  type BrokerAddress,
  type CodecRegistry,
  type Decoder,
  type KafkaConnectionOptions,
  type KafkaConsumerClock,
  type PartitionBatch,
  type PolledRecord,
  type RebalanceEvent,
  type TopicPartition,
  type TopicPartitionOffset,
} from '@ferrule/codecs';
import {
  BatchNotifier,
  FerruleError,
  isLogEvent,
  isMetricEvent,
  isSpanEvent,
  Timestamp,
  type DeliveryStatus,
  type Event,
  type EventKind,
  type Value,
  type ValueMap,
} from '@ferrule/core';
import {
  defineSource,
  DEFAULT_PORT,
  Metrics,
  type BuildContext,
  type Clock,
  type Source,
  type SourceContext,
} from '@ferrule/runtime';
import { s, type Infer } from '@ferrule/schema';
import { decodingSchema, splitCodecOptions } from './fragments.js';

// ---------------------------------------------------------------------------------------------
// Options
// ---------------------------------------------------------------------------------------------

// TLS/SASL for *connecting out to the brokers*, structurally identical to `@ferrule/sinks`'s
// kafka sink (per this source's own task: "SASL/TLS options consistent with the Kafka sink") —
// not this package's own `tlsSchema` fragment, which is for a source terminating TLS itself
// (http_server, otlp, syslog's tcp mode); a Kafka source is a client dialling out, like the sink.
const kafkaClientTlsSchema = s
  .object({
    enabled: s.boolean().optional().describe('Require TLS for this connection.'),
    ca_file: s
      .string()
      .optional()
      .describe('Path to a PEM CA bundle used instead of the default trust store.'),
    cert_file: s.string().optional().describe('Path to a PEM client certificate, for mutual TLS.'),
    key_file: s.string().optional().describe('Path to the PEM private key matching cert_file.'),
    verify_certificate: s.boolean().default(true).describe('Verify the broker certificate.'),
    server_name: s
      .string()
      .optional()
      .describe('Overrides the hostname used for SNI and certificate verification.'),
  })
  .optional()
  .describe('TLS options for connecting to the brokers.')
  .example({ ca_file: '/etc/ferrule/tls/ca.pem' });

const kafkaSaslSchema = s
  .object({
    mechanism: s.enum(['PLAIN', 'SCRAM-SHA-256']),
    username: s.string(),
    password: s.string().secret(),
  })
  .optional()
  .describe('SASL authentication for connecting to the brokers.')
  .example({ mechanism: 'PLAIN', username: 'ferrule', password: '${secret:KAFKA_PASSWORD}' });

const options = s
  .object({
    brokers: s
      .array(s.socketAddress(), { minItems: 1 })
      .describe(
        'Bootstrap broker addresses (host:port); metadata discovers the rest of the cluster.',
      )
      .example(['127.0.0.1:9092']),
    client_id: s.string().default('ferrule').describe('Client ID reported to the brokers.'),
    group_id: s
      .string()
      .nonEmpty()
      .describe('Consumer group ID. Offsets are committed under this group.'),
    topics: s
      .array(s.string().nonEmpty())
      .default([])
      .describe('Literal topic names to subscribe to.')
      .example(['events']),
    topic_pattern: s
      .regex()
      .optional()
      .describe(
        'A regular expression matched against the cluster’s topic list once at startup; every ' +
          'matching topic is added to topics. A topic created afterward that matches is only ' +
          'picked up once this source restarts.',
      ),
    tls: kafkaClientTlsSchema,
    sasl: kafkaSaslSchema,
    assignor: s
      .enum(['range', 'cooperative_sticky'])
      .default('range')
      .describe('Partition assignment strategy run by the group’s elected leader.'),
    auto_offset_reset: s
      .enum(['earliest', 'latest'])
      .default('latest')
      .describe(
        'Where to position a partition with no committed offset, or whose committed offset ' +
          'the broker reports out of range: at the start of the log (earliest) or its current ' +
          'end (latest).',
      ),
    isolation_level: s
      .enum(['read_uncommitted', 'read_committed'])
      .default('read_uncommitted')
      .describe(
        'read_uncommitted sees every record, including ones from an aborted transaction; ' +
          'read_committed filters them out.',
      ),
    decoding: decodingSchema('json'),
    connect_timeout: s.duration().default(10_000).describe('Timeout connecting to a broker.'),
    session_timeout: s
      .duration()
      .default(10_000)
      .describe('How long the coordinator waits for a heartbeat before evicting this member.'),
    rebalance_timeout: s
      .duration()
      .default(60_000)
      .describe('How long a rebalance waits for every expected member to rejoin.'),
    heartbeat_interval: s.duration().optional().describe('Default: a third of session_timeout.'),
    fetch_min_bytes: s
      .byteSize()
      .default(1)
      .describe('Minimum bytes the broker waits to accumulate before answering a Fetch.'),
    fetch_max_bytes: s
      .byteSize()
      .default(1024 * 1024)
      .describe('Maximum bytes per Fetch response.'),
    fetch_max_wait: s
      .duration()
      .default(500)
      .describe('Maximum time the broker waits for fetch_min_bytes before answering anyway.'),
    partition_max_bytes: s
      .byteSize()
      .default(1024 * 1024)
      .describe('Maximum bytes fetched per partition per Fetch.'),
    max_outstanding_batches: s
      .integer({ min: 1 })
      .default(64)
      .describe(
        'Maximum not-yet-acknowledged fetched batches kept per partition before pausing that ' +
          'partition’s fetching (backpressure) until one resolves.',
      ),
    rebalance_commit_timeout: s
      .duration()
      .default(5_000)
      .describe(
        'Bounded wait, when a partition is revoked, for its in-flight acknowledgements to ' +
          'resolve before committing its acknowledged prefix and releasing it.',
      ),
    key_field: s
      .string()
      .default('kafka.key')
      .describe('Field each event is annotated with: the record key.'),
    headers_field: s
      .string()
      .default('kafka.headers')
      .describe('Field each event is annotated with: the record headers.'),
    topic_field: s
      .string()
      .default('kafka.topic')
      .describe('Field each event is annotated with: the source topic.'),
    partition_field: s
      .string()
      .default('kafka.partition')
      .describe('Field each event is annotated with: the source partition.'),
    offset_field: s
      .string()
      .default('kafka.offset')
      .describe('Field each event is annotated with: the record offset.'),
    timestamp_field: s
      .string()
      .optional()
      .describe(
        'If set, each event is annotated with the record’s broker timestamp under this field.',
      ),
  })
  .refine(
    (o) => o.topics.length > 0 || o.topic_pattern !== undefined,
    'topics or topic_pattern must be set',
  );

export type KafkaSourceOptions = Infer<typeof options>;

// ---------------------------------------------------------------------------------------------
// Per-partition outstanding-range tracking (mirrors file.ts's OutstandingRange/TrackedFile)
// ---------------------------------------------------------------------------------------------

interface OutstandingRange {
  /** The next offset to read on resume once this batch (and everything before it) is safely
   * accounted for — Kafka's own convention for a committed offset. */
  readonly endOffset: bigint;
  status: DeliveryStatus | 'pending';
  /** Only set for a `'pending'` range; lets a bounded wait (see the rebalance handling above)
   * race this batch's actual resolution against a timeout without polling. */
  readonly completion?: Promise<DeliveryStatus>;
}

interface PartitionState {
  readonly topic: string;
  readonly partition: number;
  outstanding: OutstandingRange[];
  /** The highest offset known safe to commit, or `undefined` if nothing has resolved yet since
   * this partition was assigned. */
  committedOffset: bigint | undefined;
  /** The offset actually last sent via `consumer.commit()`, to avoid redundant commit calls. */
  lastCommittedSent: bigint | undefined;
  paused: boolean;
}

function tpKey(topic: string, partition: number): string {
  return `${topic}\u0000${partition}`;
}

function newPartitionState(topic: string, partition: number): PartitionState {
  return {
    topic,
    partition,
    outstanding: [],
    committedOffset: undefined,
    lastCommittedSent: undefined,
    paused: false,
  };
}

// ---------------------------------------------------------------------------------------------
// produces(): depends on the configured codec, same convention as stdin.ts/http_server.ts
// ---------------------------------------------------------------------------------------------

function producesForCodec(name: string): readonly EventKind[] {
  switch (name) {
    case 'prometheus_text':
    case 'statsd':
      return ['metric'];
    case 'otlp_protobuf':
    case 'otlp_json':
      return ['log', 'metric', 'span'];
    default:
      return ['log'];
  }
}

// ---------------------------------------------------------------------------------------------
// Metadata annotation: key/headers/topic/partition/offset, branched per event kind since only
// LogEvent has a generic `.set(path, value)` — MetricEvent's tags are a flat Map<string,string>
// (no key/headers), SpanEvent's attributes is a full Map<string, Value> like a LogEvent's fields.
// ---------------------------------------------------------------------------------------------

function headersToValue(headers: readonly { key: string; value: Buffer | null }[]): Value[] {
  return headers.map((h) => {
    const m: ValueMap = new Map();
    m.set('key', h.key);
    m.set('value', h.value);
    return m;
  });
}

function annotateRecordMetadata(
  event: Event,
  opts: KafkaSourceOptions,
  record: PolledRecord,
): void {
  if (isLogEvent(event) || isSpanEvent(event)) {
    const set = isLogEvent(event)
      ? (path: string, value: Value) => event.set(path, value)
      : (path: string, value: Value) => event.attributes.set(path, value);
    set(opts.topic_field, record.topic);
    set(opts.partition_field, record.partition);
    set(opts.offset_field, record.offset);
    if (record.key !== null) set(opts.key_field, record.key);
    if (record.headers.length > 0) set(opts.headers_field, headersToValue(record.headers));
    if (opts.timestamp_field !== undefined) {
      set(opts.timestamp_field, Timestamp.fromMillis(record.timestamp));
    }
    return;
  }
  if (isMetricEvent(event)) {
    event.tags.set(opts.topic_field, record.topic);
    event.tags.set(opts.partition_field, String(record.partition));
    event.tags.set(opts.offset_field, record.offset.toString());
    if (record.key !== null) event.tags.set(opts.key_field, record.key.toString('utf8'));
  }
}

// ---------------------------------------------------------------------------------------------
// Topic resolution: literal names as-is; topic_pattern matched against the cluster's topic list
// (discovered once, via Metadata(topics: null)), resolved before the consumer group client is
// constructed since KafkaConsumer cannot change a running member's subscription.
// ---------------------------------------------------------------------------------------------

function connectionOptionsFor(
  opts: KafkaSourceOptions,
): Omit<KafkaConnectionOptions, 'host' | 'port'> {
  return {
    clientId: opts.client_id,
    ...(opts.tls !== undefined ? { tls: opts.tls } : {}),
    ...(opts.sasl !== undefined ? { sasl: opts.sasl } : {}),
    connectTimeoutMs: opts.connect_timeout,
  };
}

async function resolveTopics(
  literalTopics: readonly string[],
  pattern: RegExp | undefined,
  brokers: readonly BrokerAddress[],
  connOptions: Omit<KafkaConnectionOptions, 'host' | 'port'>,
): Promise<string[]> {
  if (pattern === undefined) return [...new Set(literalTopics)];
  let lastError: unknown;
  for (const addr of brokers) {
    const conn = new KafkaBrokerConnection({ host: addr.host, port: addr.port, ...connOptions });
    try {
      await conn.connect();
      const body = await conn.sendRequest(
        ApiKey.Metadata,
        9,
        true,
        encodeMetadataRequestV9(null, false),
      );
      const response = decodeMetadataResponseV9(body);
      const allTopics: string[] = [];
      for (const t of response.topics) {
        if (t.errorCode === 0 && t.name !== null) allTopics.push(t.name);
      }
      const matched = allTopics.filter((name) => pattern.test(name));
      return [...new Set([...literalTopics, ...matched])];
    } catch (error) {
      lastError = error;
    } finally {
      await conn.close().catch(() => undefined);
    }
  }
  throw lastError instanceof Error
    ? lastError
    : new FerruleError(
        'E_KAFKA_SOURCE_TOPIC_DISCOVERY',
        'failed to reach any bootstrap broker to resolve topic_pattern',
      );
}

function adaptClock(clock: Clock): KafkaConsumerClock {
  return {
    now: () => clock.now().toMillis(),
    sleep: (ms, signal) => clock.sleep(ms, signal),
  };
}

function describeErr(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function realDelay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

// ---------------------------------------------------------------------------------------------
// Source
// ---------------------------------------------------------------------------------------------

export interface KafkaSourceHandle extends Source {
  /** This source's currently-owned partitions, for tests. */
  assignment(): readonly TopicPartition[];
}

export const kafkaSource = defineSource<KafkaSourceOptions>({
  kind: 'source',
  type: 'kafka',
  description:
    'Consumes Kafka topics via a hand-written protocol client, with acknowledgement-driven, ' +
    'per-partition offset commits.',
  options,
  produces: (opts) => producesForCodec(opts.decoding.codec),
  examples: [
    {
      title: 'Consume JSON events from a topic',
      config: {
        brokers: ['127.0.0.1:9092'],
        group_id: 'ferrule',
        topics: ['events'],
        decoding: { codec: 'json' },
      },
    },
    {
      title: 'Subscribe to every topic matching a pattern, replaying from the start',
      config: {
        brokers: ['127.0.0.1:9092'],
        group_id: 'ferrule',
        topic_pattern: '^events-.*$',
        auto_offset_reset: 'earliest',
        decoding: { codec: 'ndjson' },
      },
    },
  ],
  build(opts: KafkaSourceOptions, _buildCtx: BuildContext): KafkaSourceHandle {
    const codecs: CodecRegistry = defaultCodecs;
    const [decodingCodec, decodingOptions] = splitCodecOptions(opts.decoding);
    const decoder: Decoder = codecs.createDecoder(decodingCodec, decodingOptions);

    let activeConsumer: KafkaConsumer | undefined;

    async function run(ctx: SourceContext): Promise<void> {
      const resolvedTopics = await resolveTopics(
        opts.topics,
        opts.topic_pattern,
        opts.brokers,
        connectionOptionsFor(opts),
      );
      if (resolvedTopics.length === 0) {
        throw new FerruleError(
          'E_KAFKA_SOURCE_NO_TOPICS',
          `no topics matched this source's configuration (topics=${JSON.stringify(opts.topics)}, ` +
            `topic_pattern=${opts.topic_pattern?.source ?? 'none'})`,
        );
      }

      const partitions = new Map<string, PartitionState>();
      const dirty = new Set<string>();

      const partitionsOwned = ctx.metrics.gauge('kafka_source_partitions_owned');
      const recordsFetched = ctx.metrics.counter('kafka_source_records_fetched_total');
      const discardedEvents = ctx.metrics.counter(Metrics.discardedEvents);
      const errorsCounter = ctx.metrics.counter(Metrics.errors);

      function tryAdvance(state: PartitionState): void {
        let advanced = false;
        while (state.outstanding.length > 0) {
          const head = state.outstanding[0]!;
          if (head.status === 'pending' || head.status === 'errored') break;
          state.outstanding.shift();
          state.committedOffset = head.endOffset;
          advanced = true;
        }
        if (!advanced) return;
        dirty.add(tpKey(state.topic, state.partition));
        if (state.paused && state.outstanding.length < opts.max_outstanding_batches) {
          state.paused = false;
          consumer.resumePartitions([{ topic: state.topic, partition: state.partition }]);
        }
      }

      function queueRange(state: PartitionState, endOffset: bigint, status: DeliveryStatus): void {
        state.outstanding.push({ endOffset, status });
        tryAdvance(state);
      }

      async function commitDirty(): Promise<void> {
        if (dirty.size === 0) return;
        const keys = [...dirty];
        dirty.clear();
        const toCommit: TopicPartitionOffset[] = [];
        for (const key of keys) {
          const state = partitions.get(key);
          if (state === undefined || state.committedOffset === undefined) continue;
          if (state.committedOffset === state.lastCommittedSent) continue;
          toCommit.push({
            topic: state.topic,
            partition: state.partition,
            offset: state.committedOffset,
          });
        }
        if (toCommit.length === 0) return;
        try {
          await consumer.commit(toCommit);
          for (const tpo of toCommit) {
            const state = partitions.get(tpKey(tpo.topic, tpo.partition));
            if (state !== undefined) state.lastCommittedSent = tpo.offset;
          }
        } catch (error) {
          errorsCounter.increment();
          ctx.logger.warn('kafka: offset commit failed; will retry on the next cycle', {
            error: describeErr(error),
          });
          for (const tpo of toCommit) dirty.add(tpKey(tpo.topic, tpo.partition));
        }
      }

      async function handleBatch(batch: PartitionBatch): Promise<void> {
        const key = tpKey(batch.topic, batch.partition);
        const state = partitions.get(key);
        if (state === undefined) return; // revoked between poll() returning and processing

        recordsFetched.increment(batch.records.length);
        const perRecordEvents: { record: PolledRecord; events: Event[] }[] = [];
        let decodeErrorCount = 0;
        for (const record of batch.records) {
          if (record.value === null) continue; // a compacted-topic tombstone: nothing to decode
          try {
            const decoded = decoder.decode(record.value);
            if (decoded.length > 0) perRecordEvents.push({ record, events: decoded });
          } catch (error) {
            decodeErrorCount++;
            ctx.logger.debug('kafka: decode error', {
              topic: batch.topic,
              partition: batch.partition,
              offset: record.offset.toString(),
              error: describeErr(error),
            });
          }
        }
        if (decodeErrorCount > 0) {
          discardedEvents.increment(decodeErrorCount);
          errorsCounter.increment(decodeErrorCount);
        }

        for (const { record, events } of perRecordEvents) {
          for (const event of events) annotateRecordMetadata(event, opts, record);
        }
        const allEvents = perRecordEvents.flatMap((p) => p.events);

        const lastRecord = batch.records[batch.records.length - 1]!;
        const endOffset = lastRecord.offset + 1n;

        if (allEvents.length === 0) {
          queueRange(state, endOffset, 'delivered');
          return;
        }

        const notifier = new BatchNotifier();
        for (const event of allEvents) event.metadata.finalizers.add(notifier.createFinalizer());
        notifier.seal();
        await ctx.output.send(allEvents, DEFAULT_PORT);

        if (!ctx.acknowledgements) {
          queueRange(state, endOffset, 'delivered');
          return;
        }

        const range: OutstandingRange = {
          endOffset,
          status: 'pending',
          completion: notifier.completion,
        };
        state.outstanding.push(range);
        void notifier.completion.then((status) => {
          range.status = status;
          if (status === 'errored') {
            ctx.logger.warn(
              'kafka: delivery errored; this partition’s committed offset will not advance past this batch',
              { topic: batch.topic, partition: batch.partition },
            );
          }
          tryAdvance(state);
        });

        if (state.outstanding.length >= opts.max_outstanding_batches && !state.paused) {
          state.paused = true;
          consumer.pausePartitions([{ topic: state.topic, partition: state.partition }]);
        }
      }

      async function onRebalance({ assigned, revoked }: RebalanceEvent): Promise<void> {
        for (const tp of revoked) {
          const key = tpKey(tp.topic, tp.partition);
          const state = partitions.get(key);
          partitions.delete(key);
          dirty.delete(key);
          if (state === undefined) continue;

          const pending = state.outstanding
            .filter((r) => r.status === 'pending' && r.completion !== undefined)
            .map((r) => r.completion!);
          if (pending.length > 0) {
            await Promise.race([
              Promise.all(pending),
              ctx.clock.sleep(opts.rebalance_commit_timeout, ctx.signal).catch(() => undefined),
            ]);
          }
          tryAdvance(state);
          dirty.delete(key); // committed directly below, not via the main loop's batched commit
          if (
            state.committedOffset !== undefined &&
            state.committedOffset !== state.lastCommittedSent
          ) {
            try {
              await consumer.commit([
                { topic: tp.topic, partition: tp.partition, offset: state.committedOffset },
              ]);
            } catch (error) {
              errorsCounter.increment();
              ctx.logger.warn('kafka: failed to commit a revoked partition’s acknowledged offset', {
                topic: tp.topic,
                partition: tp.partition,
                error: describeErr(error),
              });
            }
          }
        }
        for (const tp of assigned) {
          partitions.set(tpKey(tp.topic, tp.partition), newPartitionState(tp.topic, tp.partition));
        }
        partitionsOwned.set(partitions.size);
      }

      const consumer = new KafkaConsumer({
        bootstrapBrokers: opts.brokers,
        groupId: opts.group_id,
        topics: resolvedTopics,
        clientId: opts.client_id,
        ...(opts.tls !== undefined ? { tls: opts.tls } : {}),
        ...(opts.sasl !== undefined ? { sasl: opts.sasl } : {}),
        connectTimeoutMs: opts.connect_timeout,
        sessionTimeoutMs: opts.session_timeout,
        rebalanceTimeoutMs: opts.rebalance_timeout,
        ...(opts.heartbeat_interval !== undefined
          ? { heartbeatIntervalMs: opts.heartbeat_interval }
          : {}),
        assignor: opts.assignor,
        isolationLevel: opts.isolation_level,
        fetchMinBytes: opts.fetch_min_bytes,
        fetchMaxBytes: opts.fetch_max_bytes,
        fetchMaxWaitMs: opts.fetch_max_wait,
        partitionMaxBytes: opts.partition_max_bytes,
        autoOffsetReset: opts.auto_offset_reset,
        clock: adaptClock(ctx.clock),
        onRebalance,
      });
      activeConsumer = consumer;

      try {
        while (!ctx.signal.aborted) {
          if (partitions.size > 0 && [...partitions.values()].every((s) => s.paused)) {
            // KafkaConsumer.poll() returns [] immediately, without ever sending a Fetch, when
            // every owned partition is paused — this would otherwise busy-loop while waiting
            // for one to resolve and lift the pause, since there is no real Fetch round trip
            // left to pace it. Only applies once at least one partition is actually owned, so
            // this never delays the very first poll() (the one that performs this member's
            // initial join). A plain real timer, not `ctx.clock` — this is an internal
            // efficiency safeguard, not behaviour a caller configures or a test needs to drive.
            await realDelay(50);
          }
          let batches: PartitionBatch[];
          try {
            batches = await consumer.poll();
          } catch (error) {
            errorsCounter.increment();
            ctx.logger.error('kafka: poll failed', { error: describeErr(error) });
            await ctx.clock.sleep(1_000, ctx.signal).catch(() => undefined);
            continue;
          }
          for (const batch of batches) {
            try {
              await handleBatch(batch);
            } catch (error) {
              errorsCounter.increment();
              ctx.logger.error('kafka: error processing a fetched batch', {
                topic: batch.topic,
                partition: batch.partition,
                error: describeErr(error),
              });
            }
          }
          await commitDirty();
          partitionsOwned.set(partitions.size);
        }
      } finally {
        await commitDirty().catch(() => undefined);
        activeConsumer = undefined;
        await consumer.close().catch(() => undefined);
      }
    }

    return {
      run,
      assignment: () => activeConsumer?.assignment ?? [],
    };
  },
});

export default kafkaSource;
