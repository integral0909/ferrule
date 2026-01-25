import * as net from 'node:net';
import { ApiKey } from '../../../src/kafka/protocol.js';
import { KafkaReader, KafkaWriter } from '../../../src/kafka/primitives.js';
import { decodeRecordBatch, type DecodedRecordBatch } from '../../../src/kafka/record-batch.js';
import {
  scramServerFirst,
  scramServerVerifyFinal,
  type ScramServerSession,
} from './scram-server.js';

/**
 * A fake Kafka broker speaking just enough of the wire protocol to exercise the producer in
 * `src/kafka/`: `ApiVersions`, `Metadata` (v9, flexible), `Produce` (v9, flexible, decoding and
 * CRC-verifying every `RecordBatch` it receives), and `SaslHandshake`/`SaslAuthenticate` (v1,
 * PLAIN and SCRAM-SHA-256). Driven as a small async request/response pump per connection, the
 * same style as the fake PostgreSQL server.
 */

export interface FakeKafkaSaslOptions {
  readonly mechanism: 'PLAIN' | 'SCRAM-SHA-256';
  readonly username: string;
  readonly password: string;
}

export interface ReceivedProduceBatch {
  readonly topic: string;
  readonly partition: number;
  readonly decoded: DecodedRecordBatch;
}

export interface ProduceDecisionInput {
  readonly topic: string;
  readonly partition: number;
  readonly decoded: DecodedRecordBatch;
}

export type ProduceDecision = { errorCode: 0 } | { errorCode: number; errorMessage?: string };

export interface FakeKafkaBrokerOptions {
  readonly nodeId?: number;
  readonly partitionCounts?: Readonly<Record<string, number>>;
  /** Topics to answer with `errorCode` instead of real metadata (e.g. `UNKNOWN_TOPIC_OR_PARTITION`). */
  readonly topicErrors?: Readonly<Record<string, number>>;
  readonly sasl?: FakeKafkaSaslOptions;
  readonly onProduce?: (input: ProduceDecisionInput) => ProduceDecision;
}

function msg(body: Buffer): Buffer {
  const w = new KafkaWriter();
  w.int32(body.length);
  w.bytes(body);
  return w.build();
}

class KafkaConnectionHandler {
  private readonly inbox: { apiKey: number; correlationId: number; body: Buffer }[] = [];
  private waiter:
    ((m: { apiKey: number; correlationId: number; body: Buffer }) => void) | undefined;
  private recvBuffer: Buffer = Buffer.alloc(0);
  private authenticated = false;
  private scramSession: ScramServerSession | undefined;

  constructor(
    private readonly socket: net.Socket,
    private readonly options: FakeKafkaBrokerOptions,
    private readonly nodeId: number,
    private readonly selfPort: number,
    readonly receivedBatches: ReceivedProduceBatch[],
  ) {
    socket.on('data', (chunk: Buffer) => this.onData(chunk));
    socket.on('error', () => undefined);
  }

  private onData(chunk: Buffer): void {
    this.recvBuffer =
      this.recvBuffer.length === 0 ? chunk : Buffer.concat([this.recvBuffer, chunk]);
    for (;;) {
      if (this.recvBuffer.length < 4) return;
      const size = this.recvBuffer.readInt32BE(0);
      if (this.recvBuffer.length < 4 + size) return;
      const frame = Buffer.from(this.recvBuffer.subarray(4, 4 + size));
      this.recvBuffer = this.recvBuffer.subarray(4 + size);
      const apiKey = frame.readInt16BE(0);
      const apiVersion = frame.readInt16BE(2);
      void apiVersion;
      const correlationId = frame.readInt32BE(4);
      let offset = 8;
      const clientIdLen = frame.readInt16BE(offset);
      offset += 2;
      if (clientIdLen >= 0) offset += clientIdLen;
      const flexible = apiKey === ApiKey.Metadata || apiKey === ApiKey.Produce;
      if (flexible) {
        // empty tagged fields section: a single 0x00 byte, since this client never sends any.
        offset += 1;
      }
      const body = frame.subarray(offset);
      const item = { apiKey, correlationId, body };
      if (this.waiter !== undefined) {
        const w = this.waiter;
        this.waiter = undefined;
        w(item);
      } else {
        this.inbox.push(item);
      }
    }
  }

  private next(): Promise<{ apiKey: number; correlationId: number; body: Buffer }> {
    const buffered = this.inbox.shift();
    if (buffered !== undefined) return Promise.resolve(buffered);
    return new Promise((resolve) => {
      this.waiter = resolve;
    });
  }

  private send(correlationId: number, body: Buffer): void {
    if (this.socket.destroyed) return;
    const header = new KafkaWriter().int32(correlationId).build();
    this.socket.write(msg(Buffer.concat([header, body])));
  }

  async run(): Promise<void> {
    for (;;) {
      const request = await this.next().catch(() => undefined);
      if (request === undefined || this.socket.destroyed) return;
      this.handle(request);
    }
  }

  private handle(request: { apiKey: number; correlationId: number; body: Buffer }): void {
    switch (request.apiKey) {
      case ApiKey.ApiVersions:
        this.handleApiVersions(request.correlationId);
        return;
      case ApiKey.SaslHandshake:
        this.handleSaslHandshake(request.correlationId, request.body);
        return;
      case ApiKey.SaslAuthenticate:
        this.handleSaslAuthenticate(request.correlationId, request.body);
        return;
      case ApiKey.Metadata:
        this.handleMetadata(request.correlationId, request.body);
        return;
      case ApiKey.Produce:
        this.handleProduce(request.correlationId, request.body);
        return;
      default:
        return;
    }
  }

  private handleApiVersions(correlationId: number): void {
    const w = new KafkaWriter();
    w.int16(0); // error_code
    w.array(
      [
        { apiKey: ApiKey.Produce, min: 0, max: 9 },
        { apiKey: ApiKey.Metadata, min: 0, max: 9 },
        { apiKey: ApiKey.SaslHandshake, min: 0, max: 1 },
        { apiKey: ApiKey.SaslAuthenticate, min: 0, max: 1 },
        { apiKey: ApiKey.ApiVersions, min: 0, max: 3 },
      ],
      (writer, v) => writer.int16(v.apiKey).int16(v.min).int16(v.max),
    );
    this.send(correlationId, w.build());
  }

  private handleSaslHandshake(correlationId: number, body: Buffer): void {
    const r = new KafkaReader(body);
    const mechanism = r.string();
    const offered = this.options.sasl === undefined ? [] : [this.options.sasl.mechanism];
    const ok = this.options.sasl !== undefined && this.options.sasl.mechanism === mechanism;
    const w = new KafkaWriter();
    w.int16(ok ? 0 : 33); // UNSUPPORTED_SASL_MECHANISM
    w.array(offered, (writer, m) => writer.string(m));
    this.send(correlationId, w.build());
  }

  private handleSaslAuthenticate(correlationId: number, body: Buffer): void {
    const r = new KafkaReader(body);
    const authBytes = r.nullableBytes() ?? Buffer.alloc(0);
    const sasl = this.options.sasl;
    const respond = (
      errorCode: number,
      errorMessage: string | null,
      responseBytes: Buffer,
    ): void => {
      const w = new KafkaWriter();
      w.int16(errorCode);
      w.nullableString(errorMessage);
      w.nullableBytes(responseBytes);
      w.int64(0n);
      this.send(correlationId, w.build());
    };
    if (sasl === undefined) {
      respond(34, 'SASL not configured', Buffer.alloc(0)); // ILLEGAL_SASL_STATE
      return;
    }
    if (sasl.mechanism === 'PLAIN') {
      const text = authBytes.toString('utf8');
      const parts = text.split('\0');
      const [, username, password] = parts;
      if (username === sasl.username && password === sasl.password) {
        this.authenticated = true;
        respond(0, null, Buffer.alloc(0));
      } else {
        respond(58, 'invalid credentials', Buffer.alloc(0)); // SASL_AUTHENTICATION_FAILED
      }
      return;
    }
    // SCRAM-SHA-256
    if (this.scramSession === undefined) {
      const { response, session } = scramServerFirst(authBytes.toString('utf8'));
      this.scramSession = session;
      respond(0, null, Buffer.from(response, 'utf8'));
      return;
    }
    const result = scramServerVerifyFinal(
      this.scramSession,
      sasl.password,
      authBytes.toString('utf8'),
    );
    if (result.ok) {
      this.authenticated = true;
      respond(0, null, Buffer.from(result.serverFinalMessage, 'utf8'));
    } else {
      respond(58, 'SCRAM verification failed', Buffer.alloc(0));
    }
  }

  private handleMetadata(correlationId: number, body: Buffer): void {
    const r = new KafkaReader(body);
    const topicCount = r.compactArrayLength();
    const topics: string[] = [];
    for (let i = 0; i < topicCount; i++) {
      topics.push(r.compactString());
      r.skipTaggedFields();
    }

    const w = new KafkaWriter();
    w.int32(0); // throttle_time_ms
    w.compactArray(
      [{ nodeId: this.nodeId, host: '127.0.0.1', port: this.selfPort }],
      (writer, b) => {
        writer.int32(b.nodeId).compactString(b.host).int32(b.port).compactNullableString(null);
        writer.emptyTaggedFields();
      },
    );
    w.compactNullableString('fake-cluster');
    w.int32(this.nodeId);
    w.compactArray(topics, (writer, topic) => {
      const errorCode = this.options.topicErrors?.[topic] ?? 0;
      writer.int16(errorCode);
      writer.compactNullableString(topic);
      writer.boolean(false);
      const partitionCount = errorCode === 0 ? (this.options.partitionCounts?.[topic] ?? 1) : 0;
      writer.compactArray(
        Array.from({ length: partitionCount }, (_, p) => p),
        (pw, partitionIndex) => {
          pw.int16(0);
          pw.int32(partitionIndex);
          pw.int32(this.nodeId);
          pw.int32(0);
          pw.compactArray([this.nodeId], (aw, v) => aw.int32(v));
          pw.compactArray([this.nodeId], (aw, v) => aw.int32(v));
          pw.compactArray([], () => undefined);
          pw.emptyTaggedFields();
        },
      );
      writer.int32(0); // topic_authorized_operations
      writer.emptyTaggedFields();
    });
    w.emptyTaggedFields();
    this.send(correlationId, w.build());
  }

  private handleProduce(correlationId: number, body: Buffer): void {
    const r = new KafkaReader(body);
    r.compactNullableString(); // transactional_id
    const acks = r.int16();
    r.int32(); // timeout_ms
    const topicCount = r.compactArrayLength();
    const responseTopics: {
      name: string;
      partitions: { index: number; decision: ProduceDecision }[];
    }[] = [];
    for (let t = 0; t < topicCount; t++) {
      const name = r.compactString();
      const partitionCount = r.compactArrayLength();
      const partitions: { index: number; decision: ProduceDecision }[] = [];
      for (let p = 0; p < partitionCount; p++) {
        const index = r.int32();
        const records = r.compactNullableBytes();
        r.skipTaggedFields();
        const decoded = records === null ? undefined : decodeRecordBatch(records);
        if (decoded !== undefined) {
          this.receivedBatches.push({ topic: name, partition: index, decoded });
        }
        const decision: ProduceDecision =
          decoded === undefined
            ? { errorCode: 0 }
            : (this.options.onProduce?.({ topic: name, partition: index, decoded }) ?? {
                errorCode: 0,
              });
        partitions.push({ index, decision });
      }
      r.skipTaggedFields();
      responseTopics.push({ name, partitions });
    }
    r.skipTaggedFields();

    if (acks === 0) return; // no response for fire-and-forget

    const w = new KafkaWriter();
    w.compactArray(responseTopics, (writer, topic) => {
      writer.compactString(topic.name);
      writer.compactArray(topic.partitions, (pw, partition) => {
        pw.int32(partition.index);
        pw.int16(partition.decision.errorCode);
        pw.int64(0n);
        pw.int64(-1n);
        pw.int64(-1n);
        pw.compactArray([], () => undefined); // record_errors
        pw.compactNullableString(
          'errorMessage' in partition.decision ? (partition.decision.errorMessage ?? null) : null,
        );
        pw.emptyTaggedFields();
      });
      writer.emptyTaggedFields();
    });
    w.int32(0); // throttle_time_ms
    w.emptyTaggedFields();
    this.send(correlationId, w.build());
  }
}

export class FakeKafkaBroker {
  private readonly server: net.Server;
  private _port = 0;
  readonly receivedBatches: ReceivedProduceBatch[] = [];
  readonly nodeId: number;

  constructor(private readonly options: FakeKafkaBrokerOptions = {}) {
    this.nodeId = options.nodeId ?? 1;
    this.server = net.createServer((socket) => {
      const handler = new KafkaConnectionHandler(
        socket,
        this.options,
        this.nodeId,
        this._port,
        this.receivedBatches,
      );
      handler.run().catch(() => undefined);
    });
  }

  async listen(): Promise<number> {
    await new Promise<void>((resolve) => this.server.listen(0, '127.0.0.1', resolve));
    const address = this.server.address();
    this._port = typeof address === 'object' && address !== null ? address.port : 0;
    return this._port;
  }

  get port(): number {
    return this._port;
  }

  async close(): Promise<void> {
    await new Promise<void>((resolve) => this.server.close(() => resolve()));
  }
}
