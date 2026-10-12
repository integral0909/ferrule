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
  Fetch: 1,
  OffsetCommit: 8,
  OffsetFetch: 9,
  FindCoordinator: 10,
  JoinGroup: 11,
  Heartbeat: 12,
  LeaveGroup: 13,
  SyncGroup: 14,
  Metadata: 3,
  InitProducerId: 22,
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
// InitProducerId (key 22, v4; flexible) — idempotent producer bootstrap. This client only ever
// requests a brand new producer ID (`producer_id: -1`, `producer_epoch: -1`); it implements
// idempotent production, not transactions, so `transactional_id` is always null and an epoch
// bump (KIP-360, requesting the *current* producer_id back with a fenced-out old epoch) is never
// needed — a fencing error instead resets to a fresh producer ID entirely (see `producer.ts`).
// ---------------------------------------------------------------------------------------------

export function encodeInitProducerIdRequestV4(transactionTimeoutMs: number): Buffer {
  const w = new KafkaWriter();
  w.compactNullableString(null); // transactional_id
  w.int32(transactionTimeoutMs);
  w.int64(-1n); // producer_id: -1 requests a new one
  w.int16(-1); // producer_epoch: -1 requests a new one
  w.emptyTaggedFields();
  return w.build();
}

export interface InitProducerIdResponse {
  readonly throttleTimeMs: number;
  readonly errorCode: number;
  readonly producerId: bigint;
  readonly producerEpoch: number;
}

export function decodeInitProducerIdResponseV4(body: Buffer): InitProducerIdResponse {
  const r = new KafkaReader(body);
  const throttleTimeMs = r.int32();
  const errorCode = r.int16();
  const producerId = r.int64();
  const producerEpoch = r.int16();
  r.skipTaggedFields();
  return { throttleTimeMs, errorCode, producerId, producerEpoch };
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

// ---------------------------------------------------------------------------------------------
// FindCoordinator (key 10, v3; flexible) — locates the broker acting as a consumer group's
// coordinator (the one that owns `__consumer_offsets`' partition for this group's hash).
// ---------------------------------------------------------------------------------------------

export function encodeFindCoordinatorRequestV3(groupId: string): Buffer {
  const w = new KafkaWriter();
  w.compactString(groupId);
  w.int8(0); // key_type: 0 = group (1 = transaction, not used by this client)
  w.emptyTaggedFields();
  return w.build();
}

export interface FindCoordinatorResponse {
  readonly throttleTimeMs: number;
  readonly errorCode: number;
  readonly errorMessage: string | null;
  readonly nodeId: number;
  readonly host: string;
  readonly port: number;
}

export function decodeFindCoordinatorResponseV3(body: Buffer): FindCoordinatorResponse {
  const r = new KafkaReader(body);
  const throttleTimeMs = r.int32();
  const errorCode = r.int16();
  const errorMessage = r.compactNullableString();
  const nodeId = r.int32();
  const host = r.compactString();
  const port = r.int32();
  r.skipTaggedFields();
  return { throttleTimeMs, errorCode, errorMessage, nodeId, host, port };
}

// ---------------------------------------------------------------------------------------------
// JoinGroup (key 11, v7; flexible) — a member announcing itself (or rejoining) to the group
// coordinator; the coordinator answers every member with the same generation_id/leader/members
// list once every expected member has joined (or `rebalance_timeout_ms` elapses).
// ---------------------------------------------------------------------------------------------

export interface JoinGroupProtocol {
  readonly name: string;
  /** The embedded `ConsumerProtocolSubscription` bytes (see `consumer-protocol.ts`) — opaque to
   * this layer, which just carries them through. */
  readonly metadata: Buffer;
}

export function encodeJoinGroupRequestV7(
  groupId: string,
  sessionTimeoutMs: number,
  rebalanceTimeoutMs: number,
  memberId: string,
  protocolType: string,
  protocols: readonly JoinGroupProtocol[],
): Buffer {
  const w = new KafkaWriter();
  w.compactString(groupId);
  w.int32(sessionTimeoutMs);
  w.int32(rebalanceTimeoutMs);
  w.compactString(memberId);
  w.compactNullableString(null); // group_instance_id: static membership is out of scope
  w.compactString(protocolType);
  w.compactArray(protocols, (writer, protocol) => {
    writer.compactString(protocol.name);
    writer.compactNullableBytes(protocol.metadata);
    writer.emptyTaggedFields();
  });
  w.emptyTaggedFields();
  return w.build();
}

export interface JoinGroupMember {
  readonly memberId: string;
  readonly metadata: Buffer;
}

export interface JoinGroupResponse {
  readonly throttleTimeMs: number;
  readonly errorCode: number;
  readonly generationId: number;
  readonly protocolType: string | null;
  readonly protocolName: string | null;
  readonly leader: string;
  readonly memberId: string;
  readonly members: JoinGroupMember[];
}

export function decodeJoinGroupResponseV7(body: Buffer): JoinGroupResponse {
  const r = new KafkaReader(body);
  const throttleTimeMs = r.int32();
  const errorCode = r.int16();
  const generationId = r.int32();
  const protocolType = r.compactNullableString();
  const protocolName = r.compactNullableString();
  const leader = r.compactString();
  const memberId = r.compactString();
  const memberCount = r.compactArrayLength();
  const members: JoinGroupMember[] = [];
  for (let i = 0; i < memberCount; i++) {
    const memberMemberId = r.compactString();
    r.compactNullableString(); // group_instance_id: unused by this client
    const metadata = r.compactNullableBytes() ?? Buffer.alloc(0);
    r.skipTaggedFields();
    members.push({ memberId: memberMemberId, metadata });
  }
  r.skipTaggedFields();
  return {
    throttleTimeMs,
    errorCode,
    generationId,
    protocolType,
    protocolName,
    leader,
    memberId,
    members,
  };
}

// ---------------------------------------------------------------------------------------------
// SyncGroup (key 14, v5; flexible) — every member sends this after JoinGroup; the leader's
// request carries the assignment it computed for every member (this client always runs the
// assignment locally when it is the leader — see `consumer.ts` — and sends it here); the
// coordinator relays each member's own assignment back in that member's own response.
// ---------------------------------------------------------------------------------------------

export interface SyncGroupAssignment {
  readonly memberId: string;
  /** The embedded `ConsumerProtocolAssignment` bytes (see `consumer-protocol.ts`). */
  readonly assignment: Buffer;
}

export function encodeSyncGroupRequestV5(
  groupId: string,
  generationId: number,
  memberId: string,
  protocolType: string,
  protocolName: string,
  assignments: readonly SyncGroupAssignment[],
): Buffer {
  const w = new KafkaWriter();
  w.compactString(groupId);
  w.int32(generationId);
  w.compactString(memberId);
  w.compactNullableString(null); // group_instance_id
  w.compactNullableString(protocolType);
  w.compactNullableString(protocolName);
  w.compactArray(assignments, (writer, assignment) => {
    writer.compactString(assignment.memberId);
    writer.compactNullableBytes(assignment.assignment);
    writer.emptyTaggedFields();
  });
  w.emptyTaggedFields();
  return w.build();
}

export interface SyncGroupResponse {
  readonly throttleTimeMs: number;
  readonly errorCode: number;
  readonly protocolType: string | null;
  readonly protocolName: string | null;
  readonly assignment: Buffer;
}

export function decodeSyncGroupResponseV5(body: Buffer): SyncGroupResponse {
  const r = new KafkaReader(body);
  const throttleTimeMs = r.int32();
  const errorCode = r.int16();
  const protocolType = r.compactNullableString();
  const protocolName = r.compactNullableString();
  const assignment = r.compactNullableBytes() ?? Buffer.alloc(0);
  r.skipTaggedFields();
  return { throttleTimeMs, errorCode, protocolType, protocolName, assignment };
}

// ---------------------------------------------------------------------------------------------
// Heartbeat (key 12, v4; flexible) — keeps this member's session alive between JoinGroup/
// SyncGroup round trips; a `REBALANCE_IN_PROGRESS` response means another member joined or left
// and this member must call JoinGroup again.
// ---------------------------------------------------------------------------------------------

export function encodeHeartbeatRequestV4(
  groupId: string,
  generationId: number,
  memberId: string,
): Buffer {
  const w = new KafkaWriter();
  w.compactString(groupId);
  w.int32(generationId);
  w.compactString(memberId);
  w.compactNullableString(null); // group_instance_id
  w.emptyTaggedFields();
  return w.build();
}

export interface HeartbeatResponse {
  readonly throttleTimeMs: number;
  readonly errorCode: number;
}

export function decodeHeartbeatResponseV4(body: Buffer): HeartbeatResponse {
  const r = new KafkaReader(body);
  const throttleTimeMs = r.int32();
  const errorCode = r.int16();
  r.skipTaggedFields();
  return { throttleTimeMs, errorCode };
}

// ---------------------------------------------------------------------------------------------
// LeaveGroup (key 13, v5; flexible) — a clean departure (this client always sends exactly one
// member in the array, itself), so the coordinator can rebalance the rest of the group
// immediately instead of waiting out this member's session timeout.
// ---------------------------------------------------------------------------------------------

export function encodeLeaveGroupRequestV5(groupId: string, memberId: string): Buffer {
  const w = new KafkaWriter();
  w.compactString(groupId);
  w.compactArray([memberId], (writer, id) => {
    writer.compactString(id);
    writer.compactNullableString(null); // group_instance_id
    writer.emptyTaggedFields();
  });
  w.emptyTaggedFields();
  return w.build();
}

export interface LeaveGroupResponse {
  readonly throttleTimeMs: number;
  readonly errorCode: number;
}

export function decodeLeaveGroupResponseV5(body: Buffer): LeaveGroupResponse {
  const r = new KafkaReader(body);
  const throttleTimeMs = r.int32();
  const errorCode = r.int16();
  const memberCount = r.compactArrayLength();
  for (let i = 0; i < memberCount; i++) {
    r.compactString(); // member_id
    r.compactNullableString(); // group_instance_id
    r.int16(); // error_code (per-member; this client only ever leaves as a single member)
    r.skipTaggedFields();
  }
  r.skipTaggedFields();
  return { throttleTimeMs, errorCode };
}

// ---------------------------------------------------------------------------------------------
// OffsetFetch (key 9, v6; flexible) — reads this group's last committed offset for a set of
// topic-partitions (resuming consumption after a restart or a rebalance).
// ---------------------------------------------------------------------------------------------

export interface OffsetFetchTopicRequest {
  readonly name: string;
  readonly partitionIndexes: readonly number[];
}

export function encodeOffsetFetchRequestV6(
  groupId: string,
  topics: readonly OffsetFetchTopicRequest[],
): Buffer {
  const w = new KafkaWriter();
  w.compactString(groupId);
  w.compactArray(topics, (writer, topic) => {
    writer.compactString(topic.name);
    writer.compactArray(topic.partitionIndexes, (pw, index) => pw.int32(index));
    writer.emptyTaggedFields();
  });
  w.emptyTaggedFields();
  return w.build();
}

export interface OffsetFetchPartitionResponse {
  readonly partitionIndex: number;
  readonly committedOffset: bigint;
  readonly committedLeaderEpoch: number;
  readonly metadata: string | null;
  readonly errorCode: number;
}

export interface OffsetFetchTopicResponse {
  readonly name: string;
  readonly partitions: OffsetFetchPartitionResponse[];
}

export interface OffsetFetchResponse {
  readonly throttleTimeMs: number;
  readonly topics: OffsetFetchTopicResponse[];
  readonly errorCode: number;
}

export function decodeOffsetFetchResponseV6(body: Buffer): OffsetFetchResponse {
  const r = new KafkaReader(body);
  const throttleTimeMs = r.int32();
  const topicCount = r.compactArrayLength();
  const topics: OffsetFetchTopicResponse[] = [];
  for (let t = 0; t < topicCount; t++) {
    const name = r.compactString();
    const partitionCount = r.compactArrayLength();
    const partitions: OffsetFetchPartitionResponse[] = [];
    for (let p = 0; p < partitionCount; p++) {
      const partitionIndex = r.int32();
      const committedOffset = r.int64();
      const committedLeaderEpoch = r.int32();
      const metadata = r.compactNullableString();
      const errorCode = r.int16();
      r.skipTaggedFields();
      partitions.push({ partitionIndex, committedOffset, committedLeaderEpoch, metadata, errorCode });
    }
    r.skipTaggedFields();
    topics.push({ name, partitions });
  }
  const errorCode = r.int16();
  r.skipTaggedFields();
  return { throttleTimeMs, topics, errorCode };
}

// ---------------------------------------------------------------------------------------------
// OffsetCommit (key 8, v8; flexible) — persists this group's offsets so a restart or a rebalanced
// partition resumes from where this member left off rather than from the topic's retention start.
// ---------------------------------------------------------------------------------------------

export interface OffsetCommitPartitionRequest {
  readonly partitionIndex: number;
  readonly committedOffset: bigint;
  /** The leader epoch of the batch this offset was read from, or `-1` if unknown; carried
   * through so the broker can detect a commit against a partition that has since lost data to an
   * unclean leader election. This client does not track leader epochs from Fetch responses
   * closely enough to populate it precisely and always sends `-1` (meaning "unknown"), which a
   * real broker accepts the same way an older, pre-epoch client's commit would be accepted. */
  readonly committedLeaderEpoch: number;
  readonly committedMetadata: string | null;
}

export interface OffsetCommitTopicRequest {
  readonly name: string;
  readonly partitions: readonly OffsetCommitPartitionRequest[];
}

export function encodeOffsetCommitRequestV8(
  groupId: string,
  generationId: number,
  memberId: string,
  topics: readonly OffsetCommitTopicRequest[],
): Buffer {
  const w = new KafkaWriter();
  w.compactString(groupId);
  w.int32(generationId);
  w.compactString(memberId);
  w.compactNullableString(null); // group_instance_id
  w.compactArray(topics, (writer, topic) => {
    writer.compactString(topic.name);
    writer.compactArray(topic.partitions, (pw, partition) => {
      pw.int32(partition.partitionIndex);
      pw.int64(partition.committedOffset);
      pw.int32(partition.committedLeaderEpoch);
      pw.compactNullableString(partition.committedMetadata);
      pw.emptyTaggedFields();
    });
    writer.emptyTaggedFields();
  });
  w.emptyTaggedFields();
  return w.build();
}

export interface OffsetCommitPartitionResponse {
  readonly partitionIndex: number;
  readonly errorCode: number;
}

export interface OffsetCommitTopicResponse {
  readonly name: string;
  readonly partitions: OffsetCommitPartitionResponse[];
}

export interface OffsetCommitResponse {
  readonly throttleTimeMs: number;
  readonly topics: OffsetCommitTopicResponse[];
}

export function decodeOffsetCommitResponseV8(body: Buffer): OffsetCommitResponse {
  const r = new KafkaReader(body);
  const throttleTimeMs = r.int32();
  const topicCount = r.compactArrayLength();
  const topics: OffsetCommitTopicResponse[] = [];
  for (let t = 0; t < topicCount; t++) {
    const name = r.compactString();
    const partitionCount = r.compactArrayLength();
    const partitions: OffsetCommitPartitionResponse[] = [];
    for (let p = 0; p < partitionCount; p++) {
      const partitionIndex = r.int32();
      const errorCode = r.int16();
      r.skipTaggedFields();
      partitions.push({ partitionIndex, errorCode });
    }
    r.skipTaggedFields();
    topics.push({ name, partitions });
  }
  r.skipTaggedFields();
  return { throttleTimeMs, topics };
}

// ---------------------------------------------------------------------------------------------
// Fetch (key 1, v12; flexible) — reads records from a partition starting at a given offset.
// This client always fetches as a plain consumer (`replica_id: -1`) and never uses incremental
// fetch sessions (`session_id`/`session_epoch` stay `0`/`-1`, and `forgotten_topics_data` is
// always empty) — every Fetch request restates its full set of topic-partitions.
// `isolationLevel` selects `read_uncommitted` (0, sees every record, including ones from an
// aborted transaction — matching the Kafka consumer's own default) or `read_committed` (1,
// uses the response's `aborted_transactions` to skip them) — see `consumer.ts`'s
// `filterRecordBatches`.
// ---------------------------------------------------------------------------------------------

export interface FetchPartitionRequest {
  readonly partition: number;
  readonly fetchOffset: bigint;
  readonly partitionMaxBytes: number;
  readonly currentLeaderEpoch?: number;
}

export interface FetchTopicRequest {
  readonly topic: string;
  readonly partitions: readonly FetchPartitionRequest[];
}

export function encodeFetchRequestV12(
  topics: readonly FetchTopicRequest[],
  maxWaitMs: number,
  minBytes: number,
  maxBytes: number,
  isolationLevel: 0 | 1 = 0,
): Buffer {
  const w = new KafkaWriter();
  w.int32(-1); // replica_id
  w.int32(maxWaitMs);
  w.int32(minBytes);
  w.int32(maxBytes);
  w.int8(isolationLevel); // 0 = READ_UNCOMMITTED, 1 = READ_COMMITTED
  w.int32(0); // session_id
  w.int32(-1); // session_epoch
  w.compactArray(topics, (writer, topic) => {
    writer.compactString(topic.topic);
    writer.compactArray(topic.partitions, (pw, partition) => {
      pw.int32(partition.partition);
      pw.int32(partition.currentLeaderEpoch ?? -1);
      pw.int64(partition.fetchOffset);
      pw.int32(-1); // last_fetched_epoch: only meaningful for KIP-320 epoch validation
      pw.int64(-1n); // log_start_offset: informational only, from a follower's point of view
      pw.int32(partition.partitionMaxBytes);
      pw.emptyTaggedFields();
    });
    writer.emptyTaggedFields();
  });
  w.compactArray([], () => undefined); // forgotten_topics_data: no incremental fetch sessions
  w.compactString(''); // rack_id
  w.emptyTaggedFields();
  return w.build();
}

export interface FetchAbortedTransaction {
  readonly producerId: bigint;
  readonly firstOffset: bigint;
}

export interface FetchPartitionResponse {
  readonly partitionIndex: number;
  readonly errorCode: number;
  readonly highWatermark: bigint;
  readonly lastStableOffset: bigint;
  readonly logStartOffset: bigint;
  readonly abortedTransactions: FetchAbortedTransaction[];
  readonly preferredReadReplica: number;
  readonly records: Buffer | null;
}

export interface FetchTopicResponse {
  readonly topic: string;
  readonly partitions: FetchPartitionResponse[];
}

export interface FetchResponse {
  readonly throttleTimeMs: number;
  readonly errorCode: number;
  readonly sessionId: number;
  readonly responses: FetchTopicResponse[];
}

export function decodeFetchResponseV12(body: Buffer): FetchResponse {
  const r = new KafkaReader(body);
  const throttleTimeMs = r.int32();
  const errorCode = r.int16();
  const sessionId = r.int32();
  const topicCount = r.compactArrayLength();
  const responses: FetchTopicResponse[] = [];
  for (let t = 0; t < topicCount; t++) {
    const topic = r.compactString();
    const partitionCount = r.compactArrayLength();
    const partitions: FetchPartitionResponse[] = [];
    for (let p = 0; p < partitionCount; p++) {
      const partitionIndex = r.int32();
      const partitionErrorCode = r.int16();
      const highWatermark = r.int64();
      const lastStableOffset = r.int64();
      const logStartOffset = r.int64();
      const abortedCount = r.compactArrayLength();
      const abortedTransactions: FetchAbortedTransaction[] = [];
      for (let a = 0; a < abortedCount; a++) {
        const producerId = r.int64();
        const firstOffset = r.int64();
        r.skipTaggedFields();
        abortedTransactions.push({ producerId, firstOffset });
      }
      const preferredReadReplica = r.int32();
      const records = r.compactNullableBytes();
      r.skipTaggedFields();
      partitions.push({
        partitionIndex,
        errorCode: partitionErrorCode,
        highWatermark,
        lastStableOffset,
        logStartOffset,
        abortedTransactions,
        preferredReadReplica,
        records,
      });
    }
    r.skipTaggedFields();
    responses.push({ topic, partitions });
  }
  r.skipTaggedFields();
  return { throttleTimeMs, errorCode, sessionId, responses };
}
