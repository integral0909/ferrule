import { utf8Encode, type Event } from '@ferrule/core';
import { defaultCodecs, type CodecRegistry } from '@ferrule/codecs';
import {
  defineSink,
  runBatchedSink,
  SinkError,
  type BuildContext,
  type Sink,
  type SinkContext,
} from '@ferrule/runtime';
import { s, type Infer } from '@ferrule/schema';
import {
  batchSchema,
  buildRetryPolicy,
  encodingSchema,
  retrySchema,
  splitCodecOptions,
  tlsSchema,
} from '../fragments.js';
import { compileTemplate, renderTemplate, type CompiledTemplate } from '../stream/template.js';
import { KafkaError } from './errors.js';
import { KafkaProducer, type OutgoingRecord } from './producer.js';

export const kafkaSinkOptionsSchema = s
  .object({
    /** Bootstrap broker addresses (`host:port`); metadata discovers the rest of the cluster. */
    brokers: s.array(s.socketAddress(), { minItems: 1 }),
    client_id: s.string().default('ferrule'),
    tls: tlsSchema,
    sasl: s
      .object({
        mechanism: s.enum(['PLAIN', 'SCRAM-SHA-256']),
        username: s.string(),
        password: s.string().secret(),
      })
      .optional(),
    /** Topic template. Supports `{{ field.path }}`. */
    topic: s.string().nonEmpty(),
    /** Key template; unset means unkeyed records (partitioned by `partitioner`). */
    key: s.string().optional(),
    /** Header name -> value template. */
    headers: s.record(s.string()).optional(),
    /** Codec used to encode each event. Default `json`. */
    encoding: encodingSchema('json'),
    acks: s.enum(['0', '1', '-1']).default('-1'),
    compression: s.enum(['none', 'gzip']).default('none'),
    /** Partition strategy for unkeyed records. Default `sticky` (KIP-480). */
    partitioner: s.enum(['round_robin', 'sticky']).default('sticky'),
    connect_timeout: s.duration().default(10_000),
    request_timeout: s.duration().default(30_000),
    max_in_flight_requests_per_connection: s.integer({ min: 1 }).default(5),
    /** Enables the idempotent producer (`InitProducerId`, a producer epoch, and per-partition
     * sequence numbers in every `RecordBatch`): a retry after a partial failure resends the
     * exact same sequence range instead of risking a duplicate. Requires `acks: "-1"` and
     * `max_in_flight_requests_per_connection` of at most 5 (both checked below). Default `true`. */
    idempotent: s.boolean().default(true),
    /** Groups events into batches before producing them. Default: 500 events / 1MiB / 1s. */
    batch: batchSchema,
    /** Retry backoff for produce failures. Default 250ms/30s. */
    retry: retrySchema,
  })
  .refine(
    (o) => !o.idempotent || o.acks === '-1',
    'idempotent requires acks: "-1" (every replica must acknowledge before a sequence number is committed)',
  )
  .refine(
    (o) => !o.idempotent || o.max_in_flight_requests_per_connection <= 5,
    'idempotent requires max_in_flight_requests_per_connection of at most 5 (a broker only keeps the last 5 unacknowledged batches per partition for deduplication)',
  );

export type KafkaSinkOptions = Infer<typeof kafkaSinkOptionsSchema>;

function buildProducer(options: KafkaSinkOptions): KafkaProducer {
  return new KafkaProducer({
    bootstrapBrokers: options.brokers,
    clientId: options.client_id,
    ...(options.tls !== undefined ? { tls: options.tls } : {}),
    ...(options.sasl !== undefined ? { sasl: options.sasl } : {}),
    connectTimeoutMs: options.connect_timeout,
    maxInFlightRequestsPerConnection: options.max_in_flight_requests_per_connection,
    acks: Number(options.acks) as -1 | 0 | 1,
    requestTimeoutMs: options.request_timeout,
    compression: options.compression,
    partitioner: options.partitioner,
    idempotent: options.idempotent,
  });
}

function makeEncodeBatch(
  options: KafkaSinkOptions,
  encoder: { encode(event: Event): Uint8Array },
  topicTemplate: CompiledTemplate,
  keyTemplate: CompiledTemplate | undefined,
  headerTemplates: readonly (readonly [string, CompiledTemplate])[],
  ctx: SinkContext,
): (events: Event[]) => OutgoingRecord[] {
  return (events: Event[]): OutgoingRecord[] => {
    const now = ctx.clock.now();
    const out: OutgoingRecord[] = [];
    for (const event of events) {
      const topic = renderTemplate(topicTemplate, event, now);
      if (topic.trim() === '') {
        ctx.logger.warn('kafka sink rejected an event with an empty rendered topic', {
          template: options.topic,
        });
        event.metadata.finalizers.finish('rejected');
        continue;
      }
      let value: Uint8Array;
      try {
        value = encoder.encode(event);
      } catch (error) {
        ctx.logger.warn('kafka sink failed to encode an event', {
          error: error instanceof Error ? error.message : String(error),
        });
        event.metadata.finalizers.finish('rejected');
        continue;
      }
      const key =
        keyTemplate === undefined ? null : utf8Encode(renderTemplate(keyTemplate, event, now));
      const headers = headerTemplates.map(([name, template]) => ({
        key: name,
        value: utf8Encode(renderTemplate(template, event, now)),
      }));
      out.push({
        topic,
        key,
        value,
        headers,
        timestamp: BigInt(now.toMillis()),
        event,
      });
    }
    return out;
  };
}

export function createKafkaSink(
  options: KafkaSinkOptions,
  codecs: CodecRegistry = defaultCodecs,
): Sink {
  const [codec, codecOptions] = splitCodecOptions(options.encoding);
  const encoder = codecs.createEncoder(codec, codecOptions);
  const topicTemplate = compileTemplate(options.topic);
  const keyTemplate = options.key !== undefined ? compileTemplate(options.key) : undefined;
  const headerTemplates: (readonly [string, CompiledTemplate])[] =
    options.headers === undefined
      ? []
      : [...options.headers].map(([name, tpl]) => [name, compileTemplate(tpl)] as const);

  return {
    async run(ctx: SinkContext): Promise<void> {
      const producer = buildProducer(options);
      const encodeBatch = makeEncodeBatch(
        options,
        encoder,
        topicTemplate,
        keyTemplate,
        headerTemplates,
        ctx,
      );
      try {
        await runBatchedSink(ctx, {
          maxEvents: options.batch?.max_events ?? 500,
          maxBytes: options.batch?.max_size ?? 1024 * 1024,
          timeoutMs: options.batch?.timeout ?? 1_000,
          encode: encodeBatch,
          send: async (outgoing: OutgoingRecord[]) => {
            try {
              await producer.send(outgoing);
            } catch (error) {
              if (error instanceof KafkaError) {
                if (error.isRetryable) {
                  throw SinkError.retryable('E_KAFKA_RETRYABLE', error.message, { cause: error });
                }
                throw SinkError.permanent('E_KAFKA_PERMANENT', error.message, error);
              }
              throw SinkError.retryable(
                'E_KAFKA_CONNECTION',
                error instanceof Error ? error.message : String(error),
                {
                  cause: error,
                },
              );
            }
          },
          retry: buildRetryPolicy(options.retry ?? { initial_backoff: 250, max_backoff: 30_000 }),
        });
      } finally {
        await producer.close();
      }
    },
    async healthcheck(): Promise<void> {
      const producer = buildProducer(options);
      try {
        await producer.healthcheck();
      } finally {
        await producer.close();
      }
    },
  };
}

export const kafkaSink = defineSink({
  kind: 'sink',
  type: 'kafka',
  description:
    'Produces events to Kafka via a hand-written protocol client (RecordBatch v2, murmur2 partitioning).',
  options: kafkaSinkOptionsSchema,
  accepts: ['log', 'metric', 'span'],
  examples: [
    {
      title: 'JSON events keyed by host',
      config: {
        brokers: ['127.0.0.1:9092'],
        topic: 'logs',
        key: '{{ host }}',
        encoding: { codec: 'json' },
      },
    },
  ],
  build: (options: KafkaSinkOptions, _ctx: BuildContext) => createKafkaSink(options),
});
