import { KafkaReader, KafkaWriter } from './primitives.js';

/**
 * Request/response encoders and decoders for the handful of Kafka APIs this producer needs.
 * `ApiVersions` and the SASL APIs are kept at their classic (non-flexible) versions — matching
 * real brokers, which always accept `ApiVersions` with the old header so version discovery works
 * before either side knows the other speaks flexible headers, and which never got a flexible
 * SASL version widely deployed. `Metadata` and `Produce` are implemented at flexible versions (9)
 * so the compact string/array and tagged-fields primitives are genuinely exercised on the wire,
 * not just unit-tested in isolation.
 */

export const ApiKey = {
  Produce: 0,
  Metadata: 3,
  SaslHandshake: 17,
  ApiVersions: 18,
  SaslAuthenticate: 36,
} as const;

// ---------------------------------------------------------------------------------------------
// ApiVersions (key 18, v0; non-flexible request/response headers and bodies)
// ---------------------------------------------------------------------------------------------

export interface ApiVersion {
  readonly apiKey: number;
  readonly minVersion: number;
  readonly maxVersion: number;
}

export interface ApiVersionsResponse {
  readonly errorCode: number;
  readonly apiVersions: ApiVersion[];
}

export function encodeApiVersionsRequestV0(): Buffer {
  return new KafkaWriter().build();
}

export function decodeApiVersionsResponseV0(body: Buffer): ApiVersionsResponse {
  const r = new KafkaReader(body);
  const errorCode = r.int16();
  const count = r.arrayLength();
  const apiVersions: ApiVersion[] = [];
  for (let i = 0; i < count; i++) {
    apiVersions.push({ apiKey: r.int16(), minVersion: r.int16(), maxVersion: r.int16() });
  }
  return { errorCode, apiVersions };
}

// ---------------------------------------------------------------------------------------------
// Metadata (key 3, v9; flexible request/response headers and bodies)
// ---------------------------------------------------------------------------------------------

export interface BrokerMetadata {
  readonly nodeId: number;
  readonly host: string;
  readonly port: number;
  readonly rack: string | null;
}

export interface PartitionMetadata {
  readonly errorCode: number;
  readonly partitionIndex: number;
  readonly leaderId: number;
  readonly leaderEpoch: number;
  readonly replicaNodes: number[];
  readonly isrNodes: number[];
  readonly offlineReplicas: number[];
}

export interface TopicMetadata {
  readonly errorCode: number;
  readonly name: string | null;
  readonly isInternal: boolean;
  readonly partitions: PartitionMetadata[];
}

export interface MetadataResponse {
  readonly throttleTimeMs: number;
  readonly brokers: BrokerMetadata[];
  readonly clusterId: string | null;
  readonly controllerId: number;
  readonly topics: TopicMetadata[];
}

export function encodeMetadataRequestV9(
  topics: readonly string[],
  allowAutoTopicCreation: boolean,
): Buffer {
  const w = new KafkaWriter();
  w.compactArray(topics, (writer, name) => writer.compactString(name).emptyTaggedFields());
  w.boolean(allowAutoTopicCreation);
  w.boolean(false); // include_topic_authorized_operations
  w.emptyTaggedFields();
  return w.build();
}

function decodeCompactInt32Array(r: KafkaReader): number[] {
  const len = r.compactArrayLength();
  const out: number[] = [];
  for (let i = 0; i < len; i++) out.push(r.int32());
  return out;
}

export function decodeMetadataResponseV9(body: Buffer): MetadataResponse {
  const r = new KafkaReader(body);
  const throttleTimeMs = r.int32();
  const brokerCount = r.compactArrayLength();
  const brokers: BrokerMetadata[] = [];
  for (let i = 0; i < brokerCount; i++) {
    const nodeId = r.int32();
    const host = r.compactString();
    const port = r.int32();
    const rack = r.compactNullableString();
    r.skipTaggedFields();
    brokers.push({ nodeId, host, port, rack });
  }
  const clusterId = r.compactNullableString();
  const controllerId = r.int32();
  const topicCount = r.compactArrayLength();
  const topics: TopicMetadata[] = [];
  for (let i = 0; i < topicCount; i++) {
    const errorCode = r.int16();
    const name = r.compactNullableString();
    const isInternal = r.boolean();
    const partitionCount = r.compactArrayLength();
    const partitions: PartitionMetadata[] = [];
    for (let p = 0; p < partitionCount; p++) {
      const partitionErrorCode = r.int16();
      const partitionIndex = r.int32();
      const leaderId = r.int32();
      const leaderEpoch = r.int32();
      const replicaNodes = decodeCompactInt32Array(r);
      const isrNodes = decodeCompactInt32Array(r);
      const offlineReplicas = decodeCompactInt32Array(r);
      r.skipTaggedFields();
      partitions.push({
        errorCode: partitionErrorCode,
        partitionIndex,
        leaderId,
        leaderEpoch,
        replicaNodes,
        isrNodes,
        offlineReplicas,
      });
    }
    r.int32(); // topic_authorized_operations
    r.skipTaggedFields();
    topics.push({ errorCode, name, isInternal, partitions });
  }
  r.skipTaggedFields();
  return { throttleTimeMs, brokers, clusterId, controllerId, topics };
}

// ---------------------------------------------------------------------------------------------
// Produce (key 0, v9; flexible request/response headers and bodies)
// ---------------------------------------------------------------------------------------------

export interface ProducePartitionRequest {
  readonly index: number;
  readonly records: Buffer;
}

export interface ProduceTopicRequest {
  readonly name: string;
  readonly partitions: readonly ProducePartitionRequest[];
}

export function encodeProduceRequestV9(
  topics: readonly ProduceTopicRequest[],
  acks: number,
  timeoutMs: number,
): Buffer {
  const w = new KafkaWriter();
  w.compactNullableString(null); // transactional_id
  w.int16(acks);
  w.int32(timeoutMs);
  w.compactArray(topics, (writer, topic) => {
    writer.compactString(topic.name);
    writer.compactArray(topic.partitions, (pw, partition) => {
      pw.int32(partition.index);
      pw.compactNullableBytes(partition.records);
      pw.emptyTaggedFields();
    });
    writer.emptyTaggedFields();
  });
  w.emptyTaggedFields();
  return w.build();
}

export interface RecordError {
  readonly batchIndex: number;
  readonly message: string | null;
}

export interface ProducePartitionResponse {
  readonly index: number;
  readonly errorCode: number;
  readonly baseOffset: bigint;
  readonly logAppendTimeMs: bigint;
  readonly logStartOffset: bigint;
  readonly recordErrors: RecordError[];
  readonly errorMessage: string | null;
}

export interface ProduceTopicResponse {
  readonly name: string;
  readonly partitions: ProducePartitionResponse[];
}

export interface ProduceResponse {
  readonly topics: ProduceTopicResponse[];
  readonly throttleTimeMs: number;
}

export function decodeProduceResponseV9(body: Buffer): ProduceResponse {
  const r = new KafkaReader(body);
  const topicCount = r.compactArrayLength();
  const topics: ProduceTopicResponse[] = [];
  for (let t = 0; t < topicCount; t++) {
    const name = r.compactString();
    const partitionCount = r.compactArrayLength();
    const partitions: ProducePartitionResponse[] = [];
    for (let p = 0; p < partitionCount; p++) {
      const index = r.int32();
      const errorCode = r.int16();
      const baseOffset = r.int64();
      const logAppendTimeMs = r.int64();
      const logStartOffset = r.int64();
      const recordErrorCount = r.compactArrayLength();
      const recordErrors: RecordError[] = [];
      for (let e = 0; e < recordErrorCount; e++) {
        const batchIndex = r.int32();
        const message = r.compactNullableString();
        r.skipTaggedFields();
        recordErrors.push({ batchIndex, message });
      }
      const errorMessage = r.compactNullableString();
      r.skipTaggedFields();
      partitions.push({
        index,
        errorCode,
        baseOffset,
        logAppendTimeMs,
        logStartOffset,
        recordErrors,
        errorMessage,
      });
    }
    r.skipTaggedFields();
    topics.push({ name, partitions });
  }
  const throttleTimeMs = r.int32();
  r.skipTaggedFields();
  return { topics, throttleTimeMs };
}

// ---------------------------------------------------------------------------------------------
// SaslHandshake (key 17, v1) and SaslAuthenticate (key 36, v1); both non-flexible
// ---------------------------------------------------------------------------------------------

export function encodeSaslHandshakeRequestV1(mechanism: string): Buffer {
  return new KafkaWriter().string(mechanism).build();
}

export interface SaslHandshakeResponse {
  readonly errorCode: number;
  readonly mechanisms: string[];
}

export function decodeSaslHandshakeResponseV1(body: Buffer): SaslHandshakeResponse {
  const r = new KafkaReader(body);
  const errorCode = r.int16();
  const count = r.arrayLength();
  const mechanisms: string[] = [];
  for (let i = 0; i < count; i++) mechanisms.push(r.string());
  return { errorCode, mechanisms };
}

export function encodeSaslAuthenticateRequestV1(authBytes: Uint8Array): Buffer {
  return new KafkaWriter().nullableBytes(authBytes).build();
}

export interface SaslAuthenticateResponse {
  readonly errorCode: number;
  readonly errorMessage: string | null;
  readonly authBytes: Buffer;
  readonly sessionLifetimeMs: bigint;
}

export function decodeSaslAuthenticateResponseV1(body: Buffer): SaslAuthenticateResponse {
  const r = new KafkaReader(body);
  const errorCode = r.int16();
  const errorMessage = r.nullableString();
  const authBytes = r.nullableBytes() ?? Buffer.alloc(0);
  const sessionLifetimeMs = r.int64();
  return { errorCode, errorMessage, authBytes, sessionLifetimeMs };
}
