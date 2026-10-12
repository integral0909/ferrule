import type { KafkaSaslOptions } from './sasl.js';
import {
  KafkaBrokerConnection,
  type KafkaConnectionOptions,
  type KafkaTlsOptions,
} from './connection.js';
import {
  cooperativeStickyAssignor,
  rangeAssignor,
  type Assignor,
  type AssignorSubscription,
  type TopicPartitions,
} from './assignors.js';
import {
  decodeConsumerProtocolAssignment,
  decodeConsumerProtocolSubscription,
  encodeConsumerProtocolAssignment,
  encodeConsumerProtocolSubscription,
} from './consumer-protocol.js';
import {
  KafkaCrcError,
  KafkaError,
  KafkaProtocolError,
  needsCoordinatorRediscovery,
  needsRejoin,
  KafkaErrorCode,
} from './errors.js';
import { decodeRecordBatch, type DecodedRecord } from './record-batch.js';
import {
  ApiKey,
  decodeFetchResponseV12,
  decodeFindCoordinatorResponseV3,
  decodeHeartbeatResponseV4,
  decodeJoinGroupResponseV7,
  decodeLeaveGroupResponseV5,
  decodeMetadataResponseV9,
  decodeOffsetCommitResponseV8,
  decodeOffsetFetchResponseV6,
  decodeSyncGroupResponseV5,
  encodeFetchRequestV12,
  encodeFindCoordinatorRequestV3,
  encodeHeartbeatRequestV4,
  encodeJoinGroupRequestV7,
  encodeLeaveGroupRequestV5,
  encodeMetadataRequestV9,
  encodeOffsetCommitRequestV8,
  encodeOffsetFetchRequestV6,
  encodeSyncGroupRequestV5,
} from './protocol.js';

/**
 * A hand-written Kafka consumer group client: the group membership state machine
 * (`FindCoordinator` -> `JoinGroup` -> `SyncGroup` -> stable, heartbeats on the
 * coordinator-provided interval, rebalance on `REBALANCE_IN_PROGRESS`), `OffsetFetch`/
 * `OffsetCommit`, and `Fetch` (v12, flexible) with RecordBatch v2 decoding — CRC-32C verified,
 * gzip-decompressed, control/aborted batches skipped. Exposes `poll()` (returns per-partition
 * record batches), `commit(offsets)`, and a rebalance listener (`onRebalance`).
 *
 * This is the protocol client only (GitHub issue #14); wiring it into an actual
 * `@ferrule/sources` Kafka source — a `SourceDefinition`, its option schema, checkpointing
 * against the runtime's checkpoint store, etc. — is a separate, later piece of work (issue #15).
 */

export interface BrokerAddress {
  readonly host: string;
  readonly port: number;
}

export interface TopicPartition {
  readonly topic: string;
  readonly partition: number;
}

export interface RebalanceEvent {
  readonly assigned: readonly TopicPartition[];
  readonly revoked: readonly TopicPartition[];
}

export interface PolledRecord {
  readonly topic: string;
  readonly partition: number;
  readonly offset: bigint;
  readonly timestamp: bigint;
  readonly key: Buffer | null;
  readonly value: Buffer | null;
  readonly headers: readonly { key: string; value: Buffer | null }[];
}

export interface PartitionBatch {
  readonly topic: string;
  readonly partition: number;
  readonly records: readonly PolledRecord[];
}

export interface TopicPartitionOffset {
  readonly topic: string;
  readonly partition: number;
  /** The next offset to read on resume, i.e. one past the last record this commit covers —
   * Kafka's own convention for a committed offset. */
  readonly offset: bigint;
}

/** The minimal clock surface this client needs: wall-clock time (for computing when the next
 * heartbeat is due) and a cancellable sleep (for the heartbeat loop and the join/sync/rebalance
 * timeouts). Deliberately not `@ferrule/runtime`'s `Clock` — `@ferrule/codecs` must not depend on
 * `@ferrule/runtime` (a higher layer), so a caller that already has a runtime `Clock` (a future
 * `@ferrule/sources` Kafka source, via its `SourceContext`) adapts it to this shape, which is a
 * subset of what `Clock` already provides. */
export interface KafkaConsumerClock {
  now(): number;
  sleep(ms: number, signal?: AbortSignal): Promise<void>;
}

class SystemClock implements KafkaConsumerClock {
  now(): number {
    return Date.now();
  }

  sleep(ms: number, signal?: AbortSignal): Promise<void> {
    if (signal?.aborted === true) {
      // eslint-disable-next-line @typescript-eslint/prefer-promise-reject-errors -- propagates the caller's abort reason as-is
      return Promise.reject(signal.reason as unknown);
    }
    return new Promise<void>((resolve, reject) => {
      const timer = setTimeout(() => {
        signal?.removeEventListener('abort', onAbort);
        resolve();
      }, ms);
      const onAbort = (): void => {
        clearTimeout(timer);
        // eslint-disable-next-line @typescript-eslint/prefer-promise-reject-errors -- propagates the caller's abort reason as-is
        reject(signal!.reason as unknown);
      };
      signal?.addEventListener('abort', onAbort, { once: true });
    });
  }
}

export interface KafkaConsumerOptions {
  readonly bootstrapBrokers: readonly BrokerAddress[];
  readonly groupId: string;
  readonly topics: readonly string[];
  readonly clientId?: string;
  readonly tls?: KafkaTlsOptions;
  readonly sasl?: KafkaSaslOptions;
  readonly connectTimeoutMs?: number;
  /** How long the coordinator waits for a heartbeat before considering this member dead and
   * kicking off a rebalance without it. Default 10s. */
  readonly sessionTimeoutMs?: number;
  /** How long the coordinator waits, during a rebalance, for every expected member to call
   * `JoinGroup`/`SyncGroup` before proceeding without the slow ones. Also this client's own
   * budget for completing a join/sync round trip. Default 60s. */
  readonly rebalanceTimeoutMs?: number;
  /** Default: a third of `sessionTimeoutMs`, Kafka's own usual ratio. */
  readonly heartbeatIntervalMs?: number;
  readonly assignor?: 'range' | 'cooperative_sticky';
  /** `read_uncommitted` (default, matches the Kafka consumer's own default) sees every record,
   * including ones from an aborted transaction; `read_committed` filters them out using the
   * Fetch response's `aborted_transactions`. */
  readonly isolationLevel?: 'read_uncommitted' | 'read_committed';
  readonly fetchMinBytes?: number;
  readonly fetchMaxBytes?: number;
  readonly fetchMaxWaitMs?: number;
  readonly partitionMaxBytes?: number;
  readonly clock?: KafkaConsumerClock;
  /** Called after every successful `SyncGroup` with the partitions this member gained and lost
   * in that generation (either set may be empty). Awaited before this client proceeds (e.g.
   * before fetching newly-assigned partitions), so it is a safe place to flush buffered state for
   * revoked partitions before they are handed to another member. */
  readonly onRebalance?: (event: RebalanceEvent) => void | Promise<void>;
}

const CONSUMER_PROTOCOL_TYPE = 'consumer';

function topicPartitionKey(topic: string, partition: number): string {
  return `${topic}\u0000${partition}`;
}

function assignorFor(name: 'range' | 'cooperative_sticky'): Assignor {
  return name === 'cooperative_sticky' ? cooperativeStickyAssignor : rangeAssignor;
}

function assignorProtocolName(assignor: Assignor): string {
  return assignor.name;
}

function flatten(topicPartitions: readonly TopicPartitions[]): TopicPartition[] {
  const out: TopicPartition[] = [];
  for (const tp of topicPartitions) {
    for (const partition of tp.partitions) out.push({ topic: tp.topic, partition });
  }
  return out;
}

/**
 * Applies a Fetch partition response's own abort/control bookkeeping to the RecordBatches it
 * carried: control batches (markers, never application data) are always dropped; under
 * `read_committed`, a transactional batch whose producer ID is inside an open
 * `aborted_transactions` window (tracked the same way a real consumer does — a batch "opens" the
 * window for its producer once its base offset reaches that transaction's `firstOffset`, and the
 * matching control batch for that producer closes it) is dropped too.
 */
function filterRecordBatches(
  decodedBatches: readonly {
    readonly baseOffset: bigint;
    readonly producerId: bigint;
    readonly isTransactional: boolean;
    readonly isControl: boolean;
    readonly records: readonly DecodedRecord[];
  }[],
  abortedTransactions: readonly { readonly producerId: bigint; readonly firstOffset: bigint }[],
  isolationLevel: 'read_uncommitted' | 'read_committed',
): DecodedRecord[] {
  const sortedAborted = [...abortedTransactions].sort((a, b) =>
    a.firstOffset < b.firstOffset ? -1 : a.firstOffset > b.firstOffset ? 1 : 0,
  );
  const openAborts = new Set<bigint>();
  let nextAborted = 0;
  const out: DecodedRecord[] = [];
  for (const batch of decodedBatches) {
    if (isolationLevel === 'read_committed') {
      while (
        nextAborted < sortedAborted.length &&
        sortedAborted[nextAborted]!.firstOffset <= batch.baseOffset
      ) {
        openAborts.add(sortedAborted[nextAborted]!.producerId);
        nextAborted++;
      }
    }
    if (batch.isControl) {
      openAborts.delete(batch.producerId);
      continue;
    }
    if (
      isolationLevel === 'read_committed' &&
      batch.isTransactional &&
      openAborts.has(batch.producerId)
    ) {
      continue;
    }
    out.push(...batch.records);
  }
  return out;
}

export class KafkaConsumer {
  private readonly clock: KafkaConsumerClock;
  private readonly assignor: Assignor;
  private readonly connections = new Map<string, KafkaBrokerConnection>();
  private readonly bootstrapAddrs: readonly BrokerAddress[];
  private bootstrapIndex = 0;

  private coordinatorConn: KafkaBrokerConnection | undefined;
  private memberId = '';
  private generationId = -1;
  private stable = false;
  private rejoinNeeded = false;
  private joinPromise: Promise<void> | undefined;
  private closed = false;

  /** This member's own current holdings (topic -> partitions), as of the last successful
   * `SyncGroup` — both what this client reports as `ownedPartitions` on its next `JoinGroup` and
   * what `poll()` fetches. */
  private owned: TopicPartitions[] = [];
  /** Next offset to fetch, per partition this member owns. Populated by `OffsetFetch` when a
   * partition is newly assigned, then advanced locally as records are polled. */
  private readonly nextOffset = new Map<string, bigint>();

  private readonly topicLeaders = new Map<string, Map<number, number>>();
  private readonly partitionCounts = new Map<string, number>();
  private readonly brokerAddresses = new Map<number, BrokerAddress>();

  private readonly heartbeatAbort = new AbortController();
  private heartbeatLoopDone: Promise<void> | undefined;

  constructor(private readonly options: KafkaConsumerOptions) {
    if (options.bootstrapBrokers.length === 0) {
      throw new KafkaProtocolError('at least one bootstrap broker is required');
    }
    if (options.topics.length === 0) {
      throw new KafkaProtocolError('at least one topic is required');
    }
    this.bootstrapAddrs = options.bootstrapBrokers;
    this.clock = options.clock ?? new SystemClock();
    this.assignor = assignorFor(options.assignor ?? 'range');
  }

  private get sessionTimeoutMs(): number {
    return this.options.sessionTimeoutMs ?? 10_000;
  }

  private get rebalanceTimeoutMs(): number {
    return this.options.rebalanceTimeoutMs ?? 60_000;
  }

  private get heartbeatIntervalMs(): number {
    return this.options.heartbeatIntervalMs ?? Math.max(1, Math.floor(this.sessionTimeoutMs / 3));
  }

  private get isolationLevel(): 'read_uncommitted' | 'read_committed' {
    return this.options.isolationLevel ?? 'read_uncommitted';
  }

  // -----------------------------------------------------------------------------------------
  // Connections
  // -----------------------------------------------------------------------------------------

  private connectionOptionsFor(addr: BrokerAddress): KafkaConnectionOptions {
    return {
      host: addr.host,
      port: addr.port,
      ...(this.options.clientId !== undefined ? { clientId: this.options.clientId } : {}),
      ...(this.options.tls !== undefined ? { tls: this.options.tls } : {}),
      ...(this.options.sasl !== undefined ? { sasl: this.options.sasl } : {}),
      ...(this.options.connectTimeoutMs !== undefined
        ? { connectTimeoutMs: this.options.connectTimeoutMs }
        : {}),
    };
  }

  private async getOrConnect(addr: BrokerAddress): Promise<KafkaBrokerConnection> {
    const key = `${addr.host}:${addr.port}`;
    const existing = this.connections.get(key);
    if (existing !== undefined && !existing.isClosed) return existing;
    const conn = new KafkaBrokerConnection(this.connectionOptionsFor(addr));
    await conn.connect();
    this.connections.set(key, conn);
    return conn;
  }

  private nextBootstrap(): BrokerAddress {
    const addr = this.bootstrapAddrs[this.bootstrapIndex % this.bootstrapAddrs.length]!;
    this.bootstrapIndex++;
    return addr;
  }

  private async anyBootstrapConnection(): Promise<KafkaBrokerConnection> {
    let lastError: unknown;
    for (let attempt = 0; attempt < this.bootstrapAddrs.length; attempt++) {
      try {
        return await this.getOrConnect(this.nextBootstrap());
      } catch (error) {
        lastError = error;
      }
    }
    throw lastError instanceof Error
      ? lastError
      : new KafkaProtocolError('failed to reach any bootstrap broker');
  }

  private async ensureCoordinator(): Promise<KafkaBrokerConnection> {
    if (this.coordinatorConn !== undefined && !this.coordinatorConn.isClosed) {
      return this.coordinatorConn;
    }
    const bootstrap = await this.anyBootstrapConnection();
    const body = await bootstrap.sendRequest(
      ApiKey.FindCoordinator,
      3,
      true,
      encodeFindCoordinatorRequestV3(this.options.groupId),
    );
    const response = decodeFindCoordinatorResponseV3(body);
    if (response.errorCode !== 0) {
      throw new KafkaError(response.errorCode, response.errorMessage ?? 'FindCoordinator failed');
    }
    const addr: BrokerAddress = { host: response.host, port: response.port };
    const conn = await this.getOrConnect(addr);
    this.coordinatorConn = conn;
    return conn;
  }

  private dropCoordinator(): void {
    this.coordinatorConn = undefined;
  }

  // -----------------------------------------------------------------------------------------
  // Metadata (topic -> partition -> leader), for Fetch's sake
  // -----------------------------------------------------------------------------------------

  private async refreshMetadata(topics: readonly string[]): Promise<void> {
    if (topics.length === 0) return;
    const conn = await this.anyBootstrapConnection();
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
      if (topic.name === null || topic.errorCode !== 0) continue;
      const leaders = new Map<number, number>();
      for (const partition of topic.partitions) {
        leaders.set(partition.partitionIndex, partition.leaderId);
      }
      this.topicLeaders.set(topic.name, leaders);
      this.partitionCounts.set(topic.name, topic.partitions.length);
    }
  }

  private async ensureMetadata(topics: readonly string[]): Promise<void> {
    const missing = topics.filter((t) => !this.partitionCounts.has(t));
    if (missing.length > 0) await this.refreshMetadata(missing);
  }

  // -----------------------------------------------------------------------------------------
  // Group membership: FindCoordinator -> JoinGroup -> (leader: assign) -> SyncGroup -> stable
  // -----------------------------------------------------------------------------------------

  /** Ensures this member is a stable part of the group, (re)joining if it never has, or if a
   * rejoin has been flagged (by a heartbeat response, or an OffsetCommit's error). Concurrent
   * callers (e.g. `poll()` and the heartbeat loop both noticing a rebalance at once) share one
   * in-flight join. */
  private async ensureStableGroup(): Promise<void> {
    if (this.closed) throw new KafkaProtocolError('this consumer is closed');
    if (this.stable && !this.rejoinNeeded) return;
    this.joinPromise ??= this.joinAndSync().finally(() => {
      this.joinPromise = undefined;
    });
    await this.joinPromise;
  }

  private currentSubscriptionBytes(): Buffer {
    return encodeConsumerProtocolSubscription({
      version: 1,
      topics: this.options.topics,
      userData: null,
      ownedPartitions: this.owned,
    });
  }

  private async joinAndSync(): Promise<void> {
    this.rejoinNeeded = false;
    const assignorName = assignorProtocolName(this.assignor);

    for (;;) {
      const conn = await this.ensureCoordinator();
      let joinBody: Buffer;
      try {
        joinBody = await conn.sendRequest(
          ApiKey.JoinGroup,
          7,
          true,
          encodeJoinGroupRequestV7(
            this.options.groupId,
            this.sessionTimeoutMs,
            this.rebalanceTimeoutMs,
            this.memberId,
            CONSUMER_PROTOCOL_TYPE,
            [{ name: assignorName, metadata: this.currentSubscriptionBytes() }],
          ),
        );
      } catch (error) {
        this.dropCoordinator();
        throw error;
      }
      const join = decodeJoinGroupResponseV7(joinBody);
      if (join.errorCode === KafkaErrorCode.UNKNOWN_MEMBER_ID) {
        this.memberId = '';
        continue;
      }
      if (needsCoordinatorRediscovery(join.errorCode)) {
        this.dropCoordinator();
        continue;
      }
      if (join.errorCode !== 0) {
        throw new KafkaError(join.errorCode, `JoinGroup failed for group ${this.options.groupId}`);
      }
      this.memberId = join.memberId;
      this.generationId = join.generationId;

      let assignments: { memberId: string; assignment: Buffer }[] = [];
      if (join.leader === this.memberId) {
        assignments = await this.computeAssignments(join.members, assignorName);
      }

      let syncBody: Buffer;
      try {
        syncBody = await conn.sendRequest(
          ApiKey.SyncGroup,
          5,
          true,
          encodeSyncGroupRequestV5(
            this.options.groupId,
            this.generationId,
            this.memberId,
            CONSUMER_PROTOCOL_TYPE,
            assignorName,
            assignments,
          ),
        );
      } catch (error) {
        this.dropCoordinator();
        throw error;
      }
      const sync = decodeSyncGroupResponseV5(syncBody);
      if (sync.errorCode === KafkaErrorCode.REBALANCE_IN_PROGRESS) continue;
      if (sync.errorCode === KafkaErrorCode.UNKNOWN_MEMBER_ID) {
        this.memberId = '';
        continue;
      }
      if (needsRejoin(sync.errorCode) || needsCoordinatorRediscovery(sync.errorCode)) {
        if (needsCoordinatorRediscovery(sync.errorCode)) this.dropCoordinator();
        continue;
      }
      if (sync.errorCode !== 0) {
        throw new KafkaError(sync.errorCode, `SyncGroup failed for group ${this.options.groupId}`);
      }

      const newAssignment =
        sync.assignment.length === 0
          ? []
          : decodeConsumerProtocolAssignment(sync.assignment).partitions;
      const revokedCount = await this.applyAssignment(newAssignment);
      this.stable = true;
      this.ensureHeartbeatLoop();
      // The cooperative protocol defers a moving partition's hand-off across two generations
      // (see assignors.ts): this generation revoked it from its old owner without yet giving it
      // to the new one. A member that just revoked something must rejoin immediately, rather
      // than wait for its next heartbeat, so the group converges to the next (hopefully final)
      // generation without unnecessary delay — exactly what a real KIP-429 client does.
      if (revokedCount > 0 && this.assignor === cooperativeStickyAssignor) {
        this.stable = false;
        continue;
      }
      return;
    }
  }

  /** Runs as the group leader: decodes every member's subscription (topics + what it currently
   * owns), fetches partition-count metadata for the union of their subscribed topics, and runs
   * the configured assignor. Only the leader's `SyncGroup` request carries real assignments —
   * the coordinator distributes them to every member. */
  private async computeAssignments(
    members: readonly { memberId: string; metadata: Buffer }[],
    assignorName: string,
  ): Promise<{ memberId: string; assignment: Buffer }[]> {
    const subscriptions = new Map<string, AssignorSubscription>();
    const unionTopics = new Set<string>();
    for (const member of members) {
      const sub = decodeConsumerProtocolSubscription(member.metadata);
      subscriptions.set(member.memberId, {
        topics: sub.topics,
        ownedPartitions: sub.ownedPartitions,
      });
      for (const topic of sub.topics) unionTopics.add(topic);
    }
    await this.ensureMetadata([...unionTopics]);
    const partitionCounts = new Map<string, number>();
    for (const topic of unionTopics) {
      partitionCounts.set(topic, this.partitionCounts.get(topic) ?? 0);
    }

    const assignor =
      assignorName === cooperativeStickyAssignor.name ? cooperativeStickyAssignor : rangeAssignor;
    const assigned = assignor.assign(subscriptions, partitionCounts);
    return members.map((member) => ({
      memberId: member.memberId,
      assignment: encodeConsumerProtocolAssignment({
        version: 1,
        partitions: assigned.get(member.memberId) ?? [],
        userData: null,
      }),
    }));
  }

  /** Diffs `newAssignment` against this member's previous holdings, fires `onRebalance`, fetches
   * committed offsets for newly-gained partitions, and drops tracked offset state for lost ones.
   * Returns how many partitions were revoked, so the cooperative protocol's caller (see
   * `joinAndSync`) knows whether it must rejoin immediately to complete a deferred hand-off. */
  private async applyAssignment(newAssignment: readonly TopicPartitions[]): Promise<number> {
    const previous = new Set(
      flatten(this.owned).map((tp) => topicPartitionKey(tp.topic, tp.partition)),
    );
    const next = flatten(newAssignment);
    const nextKeys = new Set(next.map((tp) => topicPartitionKey(tp.topic, tp.partition)));

    const assigned = next.filter((tp) => !previous.has(topicPartitionKey(tp.topic, tp.partition)));
    const revoked = flatten(this.owned).filter(
      (tp) => !nextKeys.has(topicPartitionKey(tp.topic, tp.partition)),
    );

    for (const tp of revoked) this.nextOffset.delete(topicPartitionKey(tp.topic, tp.partition));
    this.owned = newAssignment.map((tp) => ({ topic: tp.topic, partitions: [...tp.partitions] }));

    if (assigned.length > 0 || revoked.length > 0) {
      await this.options.onRebalance?.({ assigned, revoked });
    }
    if (assigned.length > 0) await this.fetchCommittedOffsets(assigned);
    return revoked.length;
  }

  private async fetchCommittedOffsets(partitions: readonly TopicPartition[]): Promise<void> {
    const byTopic = new Map<string, number[]>();
    for (const tp of partitions) {
      let list = byTopic.get(tp.topic);
      if (list === undefined) {
        list = [];
        byTopic.set(tp.topic, list);
      }
      list.push(tp.partition);
    }
    const conn = await this.ensureCoordinator();
    const body = await conn.sendRequest(
      ApiKey.OffsetFetch,
      6,
      true,
      encodeOffsetFetchRequestV6(
        this.options.groupId,
        [...byTopic].map(([name, partitionIndexes]) => ({ name, partitionIndexes })),
      ),
    );
    const response = decodeOffsetFetchResponseV6(body);
    for (const topic of response.topics) {
      for (const partition of topic.partitions) {
        // committedOffset of -1 means "no committed offset for this partition" (a fresh group,
        // or a partition this group has never consumed before); this client starts such a
        // partition from offset 0 — there is no ListOffsets support here to honour an
        // "earliest"/"latest" auto-reset policy against the log's actual bounds (see the known
        // gaps in the package README).
        const offset = partition.committedOffset < 0n ? 0n : partition.committedOffset;
        this.nextOffset.set(topicPartitionKey(topic.name, partition.partitionIndex), offset);
      }
    }
  }

  // -----------------------------------------------------------------------------------------
  // Heartbeats
  // -----------------------------------------------------------------------------------------

  private ensureHeartbeatLoop(): void {
    this.heartbeatLoopDone ??= this.heartbeatLoop(this.heartbeatAbort.signal).catch(
      () => undefined,
    );
  }

  private async heartbeatLoop(signal: AbortSignal): Promise<void> {
    for (;;) {
      try {
        await this.clock.sleep(this.heartbeatIntervalMs, signal);
      } catch {
        return;
      }
      if (signal.aborted || this.closed) return;
      if (!this.stable) continue; // a join/sync is already in flight; nothing to heartbeat yet
      try {
        const conn = await this.ensureCoordinator();
        const body = await conn.sendRequest(
          ApiKey.Heartbeat,
          4,
          true,
          encodeHeartbeatRequestV4(this.options.groupId, this.generationId, this.memberId),
        );
        const response = decodeHeartbeatResponseV4(body);
        if (response.errorCode === KafkaErrorCode.REBALANCE_IN_PROGRESS) {
          this.stable = false;
          this.rejoinNeeded = true;
          await this.ensureStableGroup().catch(() => undefined);
        } else if (needsRejoin(response.errorCode)) {
          this.stable = false;
          this.rejoinNeeded = true;
          if (response.errorCode === KafkaErrorCode.UNKNOWN_MEMBER_ID) this.memberId = '';
          await this.ensureStableGroup().catch(() => undefined);
        } else if (needsCoordinatorRediscovery(response.errorCode)) {
          this.dropCoordinator();
        }
      } catch {
        // A connection-level failure invalidates the coordinator connection; the next heartbeat
        // (or the next poll()/commit()) re-discovers it and rejoins if still needed.
        this.dropCoordinator();
      }
    }
  }

  // -----------------------------------------------------------------------------------------
  // Fetch
  // -----------------------------------------------------------------------------------------

  /** Polls for new records on every partition this member currently owns. Joins the group (or
   * rejoins, if a rebalance was flagged) first if needed. Returns one entry per partition that
   * actually had records after control/aborted-transaction filtering — a partition with nothing
   * new (or nothing but a control batch) is simply omitted. */
  async poll(): Promise<PartitionBatch[]> {
    if (this.closed) throw new KafkaProtocolError('this consumer is closed');
    await this.ensureStableGroup();
    const partitions = flatten(this.owned);
    if (partitions.length === 0) return [];

    const topics = [...new Set(partitions.map((tp) => tp.topic))];
    await this.ensureMetadata(topics);

    const byLeader = new Map<number, TopicPartition[]>();
    for (const tp of partitions) {
      const leaderId = this.topicLeaders.get(tp.topic)?.get(tp.partition);
      if (leaderId === undefined || leaderId < 0) continue; // no known leader yet; skip this round
      let list = byLeader.get(leaderId);
      if (list === undefined) {
        list = [];
        byLeader.set(leaderId, list);
      }
      list.push(tp);
    }

    const results = await Promise.all(
      [...byLeader.entries()].map(([nodeId, tps]) => this.fetchFromLeader(nodeId, tps)),
    );
    return results.flat();
  }

  private async fetchFromLeader(
    nodeId: number,
    partitions: readonly TopicPartition[],
  ): Promise<PartitionBatch[]> {
    const addr = this.brokerAddresses.get(nodeId);
    if (addr === undefined) {
      throw new KafkaProtocolError(`no known address for broker node ${nodeId}`);
    }
    const conn = await this.getOrConnect(addr);

    const byTopic = new Map<string, TopicPartition[]>();
    for (const tp of partitions) {
      let list = byTopic.get(tp.topic);
      if (list === undefined) {
        list = [];
        byTopic.set(tp.topic, list);
      }
      list.push(tp);
    }
    const isolationCode = this.isolationLevel === 'read_committed' ? 1 : 0;
    const requestBody = encodeFetchRequestV12(
      [...byTopic].map(([topic, tps]) => ({
        topic,
        partitions: tps.map((tp) => ({
          partition: tp.partition,
          fetchOffset: this.nextOffset.get(topicPartitionKey(tp.topic, tp.partition)) ?? 0n,
          partitionMaxBytes: this.options.partitionMaxBytes ?? 1_048_576,
        })),
      })),
      this.options.fetchMaxWaitMs ?? 500,
      this.options.fetchMinBytes ?? 1,
      this.options.fetchMaxBytes ?? 1_048_576,
      isolationCode,
    );
    const responseBody = await conn.sendRequest(ApiKey.Fetch, 12, true, requestBody);
    const response = decodeFetchResponseV12(responseBody);
    if (response.errorCode !== 0) {
      throw new KafkaError(response.errorCode, 'Fetch failed');
    }

    const out: PartitionBatch[] = [];
    for (const topicResponse of response.responses) {
      for (const partitionResponse of topicResponse.partitions) {
        if (partitionResponse.errorCode !== 0) {
          // Per-partition errors (e.g. a leader move mid-fetch) invalidate this topic's cached
          // leader so the next poll() re-resolves it; the partition is simply skipped this round
          // rather than failing the whole poll().
          this.topicLeaders.delete(topicResponse.topic);
          this.partitionCounts.delete(topicResponse.topic);
          continue;
        }
        const records = this.decodePartitionRecords(
          topicResponse.topic,
          partitionResponse.partitionIndex,
          partitionResponse.records,
          partitionResponse.abortedTransactions,
        );
        if (records.length === 0) continue;
        const last = records[records.length - 1]!;
        this.nextOffset.set(
          topicPartitionKey(topicResponse.topic, partitionResponse.partitionIndex),
          last.offset + 1n,
        );
        out.push({
          topic: topicResponse.topic,
          partition: partitionResponse.partitionIndex,
          records: records.map((r) => ({
            topic: topicResponse.topic,
            partition: partitionResponse.partitionIndex,
            offset: r.offset,
            timestamp: r.timestamp,
            key: r.key,
            value: r.value,
            headers: r.headers,
          })),
        });
      }
    }
    return out;
  }

  private decodePartitionRecords(
    topic: string,
    partition: number,
    records: Buffer | null,
    abortedTransactions: readonly { producerId: bigint; firstOffset: bigint }[],
  ): DecodedRecord[] {
    if (records === null || records.length === 0) return [];
    const batches: {
      baseOffset: bigint;
      producerId: bigint;
      isTransactional: boolean;
      isControl: boolean;
      records: DecodedRecord[];
    }[] = [];
    let offset = 0;
    while (offset < records.length) {
      const batch = decodeRecordBatch(records.subarray(offset));
      if (!batch.crcValid) throw new KafkaCrcError(topic, partition, batch.baseOffset);
      batches.push(batch);
      offset += batch.totalLength;
    }
    return filterRecordBatches(batches, abortedTransactions, this.isolationLevel);
  }

  // -----------------------------------------------------------------------------------------
  // Offset commit
  // -----------------------------------------------------------------------------------------

  async commit(offsets: readonly TopicPartitionOffset[]): Promise<void> {
    if (offsets.length === 0) return;
    if (this.closed) throw new KafkaProtocolError('this consumer is closed');
    await this.ensureStableGroup();

    const byTopic = new Map<string, TopicPartitionOffset[]>();
    for (const o of offsets) {
      let list = byTopic.get(o.topic);
      if (list === undefined) {
        list = [];
        byTopic.set(o.topic, list);
      }
      list.push(o);
    }
    const conn = await this.ensureCoordinator();
    const body = await conn.sendRequest(
      ApiKey.OffsetCommit,
      8,
      true,
      encodeOffsetCommitRequestV8(
        this.options.groupId,
        this.generationId,
        this.memberId,
        [...byTopic].map(([name, parts]) => ({
          name,
          partitions: parts.map((p) => ({
            partitionIndex: p.partition,
            committedOffset: p.offset,
            committedLeaderEpoch: -1,
            committedMetadata: null,
          })),
        })),
      ),
    );
    const response = decodeOffsetCommitResponseV8(body);
    let firstError: KafkaError | undefined;
    for (const topic of response.topics) {
      for (const partition of topic.partitions) {
        if (partition.errorCode === 0) continue;
        if (needsRejoin(partition.errorCode)) {
          this.stable = false;
          this.rejoinNeeded = true;
          if (partition.errorCode === KafkaErrorCode.UNKNOWN_MEMBER_ID) this.memberId = '';
        }
        firstError ??= new KafkaError(partition.errorCode, `OffsetCommit failed for ${topic.name}`);
      }
    }
    if (firstError !== undefined) throw firstError;
  }

  // -----------------------------------------------------------------------------------------
  // Shutdown
  // -----------------------------------------------------------------------------------------

  /** The partitions this member currently owns, for introspection (e.g. tests, or a source that
   * wants to log its own assignment). */
  get assignment(): readonly TopicPartition[] {
    return flatten(this.owned);
  }

  async close(): Promise<void> {
    if (this.closed) return;
    this.closed = true;
    this.heartbeatAbort.abort();
    await this.heartbeatLoopDone?.catch(() => undefined);
    if (
      this.memberId !== '' &&
      this.coordinatorConn !== undefined &&
      !this.coordinatorConn.isClosed
    ) {
      try {
        const body = await this.coordinatorConn.sendRequest(
          ApiKey.LeaveGroup,
          5,
          true,
          encodeLeaveGroupRequestV5(this.options.groupId, this.memberId),
        );
        decodeLeaveGroupResponseV5(body);
      } catch {
        // Best-effort: if the coordinator is unreachable there is nothing more this client can
        // do, and the group will notice this member is gone via its session timeout instead.
      }
    }
    await Promise.all([...this.connections.values()].map((c) => c.close()));
    this.connections.clear();
  }
}
