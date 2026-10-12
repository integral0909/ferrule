import * as net from 'node:net';
import {
  ApiKey,
  KafkaErrorCode,
  KafkaReader,
  KafkaWriter,
  encodeRecordBatch,
  type RecordInput,
} from '@ferrule/codecs';

/**
 * A fake Kafka broker that acts as a consumer group's coordinator — `FindCoordinator`,
 * `JoinGroup`, `SyncGroup`, `Heartbeat`, `LeaveGroup`, `OffsetFetch`/`OffsetCommit` — and serves
 * `Fetch` (reporting `OFFSET_OUT_OF_RANGE` for a fetch offset outside a partition's current
 * bounds, exactly like a real broker would), `ListOffsets` (`earliest`/`latest` against that same
 * in-memory log), and `Metadata` (including a null `topics` array, "every topic the cluster has",
 * answered from this broker's own configured `partitionCounts` — used to resolve a source's
 * `topic_pattern`) from an in-memory, per-partition log of pre-encoded `RecordBatch`es
 * (`appendRecords`). Driven by an injected clock (a small `{ now(); sleep(ms); }` shape — any
 * object with that shape works, including an adapted `@ferrule/runtime` `ManualClock`, which is
 * what this package's own tests use) for session-timeout detection, so "a member stops
 * heartbeating" is deterministic rather than racing real wall-clock time.
 *
 * This is a close copy of `packages/codecs/test/kafka/support/fake-kafka-broker.ts` (itself
 * already documented as a deliberate duplicate of `packages/sinks/test/stream/support/
 * fake-kafka-broker.ts`, for the same reason: test fixtures are not published as part of a
 * package's build, so they cannot be shared across a package boundary without an out-of-package
 * relative import). This copy additionally answers `ListOffsets`, reports `OFFSET_OUT_OF_RANGE`
 * from `Fetch`, answers a null-`topics` `Metadata` request, and exposes `committedOffset` for
 * assertions — all needed by this source's own tests, none of which the codecs client's own
 * tests need.
 */

const FLEXIBLE_API_KEYS: ReadonlySet<number> = new Set([
  ApiKey.Metadata,
  ApiKey.FindCoordinator,
  ApiKey.JoinGroup,
  ApiKey.SyncGroup,
  ApiKey.Heartbeat,
  ApiKey.LeaveGroup,
  ApiKey.OffsetFetch,
  ApiKey.OffsetCommit,
  ApiKey.Fetch,
]);

function msg(body: Buffer): Buffer {
  const w = new KafkaWriter();
  w.int32(body.length);
  w.bytes(body);
  return w.build();
}

function tpKey(topic: string, partition: number): string {
  return `${topic}\u0000${partition}`;
}

/** The minimal clock surface this broker needs — deliberately a plain structural interface
 * rather than a concrete class, so a test can adapt whatever clock it already has (this
 * package's own tests adapt `@ferrule/runtime`'s `ManualClock`, the same instance driving the
 * `KafkaConsumer` on the other end of the fake connection, so one `advance()` call moves both
 * sides of the simulated network deterministically). */
export interface FakeBrokerClock {
  now(): number;
  sleep(ms: number): Promise<void>;
}

export interface FakeGroupCoordinatorOptions {
  readonly nodeId?: number;
  readonly partitionCounts?: Readonly<Record<string, number>>;
  readonly clock?: FakeBrokerClock;
  /** How long a forming generation waits for every expected member before finalizing without
   * whichever stragglers never sent `JoinGroup` (a real coordinator's `rebalance_timeout_ms`).
   * Default 2000ms (per the injected clock, not wall time). */
  readonly rebalanceStragglerTimeoutMs?: number;
}

interface PartitionLog {
  readonly batches: Buffer[];
  readonly baseOffsets: bigint[];
  nextOffset: bigint;
  readonly abortedTransactions: { producerId: bigint; firstOffset: bigint }[];
}

interface JoinWaiter {
  readonly offeredProtocols: readonly { name: string; metadata: Buffer }[];
  readonly respond: (result: {
    generationId: number;
    leader: string;
    memberId: string;
    protocolName: string;
    members: { memberId: string; metadata: Buffer }[];
  }) => void;
}

interface RebalanceRound {
  readonly expected: Set<string>;
  readonly joined: Map<string, JoinWaiter>;
  readonly joinOrder: string[];
  /** Wall-clock time (per the injected clock) past which this round finalizes without waiting
   * for every `expected` member — mirrors a real coordinator's `rebalance_timeout_ms`: a member
   * that stops responding (crashed, network partition) must not block the rest of the group
   * forever. */
  readonly deadlineMs: number;
}

interface SyncRound {
  readonly generationId: number;
  readonly leaderId: string;
  readonly protocolName: string;
  readonly waiting: Map<string, (assignment: Buffer) => void>;
  assignments: Map<string, Buffer> | undefined;
}

interface StableMember {
  lastSeenMs: number;
}

interface Group {
  generationId: number;
  readonly stableMembers: Map<string, StableMember>;
  rebalance: RebalanceRound | undefined;
  sync: SyncRound | undefined;
  memberCounter: number;
  readonly offsets: Map<string, bigint>;
}

/** Shared across every connection this broker accepts — group and log state is cluster state on
 * a real broker, not connection state (the same reasoning `packages/sinks`'s own fake broker's
 * `BrokerState` already documents for idempotent-producer bookkeeping). */
class BrokerState {
  readonly groups = new Map<string, Group>();
  readonly logs = new Map<string, PartitionLog>();

  groupFor(groupId: string): Group {
    let group = this.groups.get(groupId);
    if (group === undefined) {
      group = {
        generationId: 0,
        stableMembers: new Map(),
        rebalance: undefined,
        sync: undefined,
        memberCounter: 0,
        offsets: new Map(),
      };
      this.groups.set(groupId, group);
    }
    return group;
  }

  logFor(topic: string, partition: number): PartitionLog {
    const key = tpKey(topic, partition);
    let log = this.logs.get(key);
    if (log === undefined) {
      log = { batches: [], baseOffsets: [], nextOffset: 0n, abortedTransactions: [] };
      this.logs.set(key, log);
    }
    return log;
  }
}

class GroupCoordinator {
  constructor(
    private readonly state: BrokerState,
    private readonly clock: FakeBrokerClock | undefined,
    private readonly sessionTimeoutMs: Map<string, number>,
    private readonly rebalanceStragglerTimeoutMs: number,
  ) {}

  private now(): number {
    return this.clock?.now() ?? Date.now();
  }

  /** Evicts any stable member that has gone silent past its session timeout, treating it exactly
   * like an explicit `LeaveGroup` (triggers a rebalance among whoever is left, if nobody else's
   * rebalance is already in flight). */
  private sweepStale(group: Group): void {
    if (group.rebalance !== undefined) return; // already mid-rebalance; nothing stable to sweep
    const now = this.now();
    const stale: string[] = [];
    for (const [memberId, member] of group.stableMembers) {
      const timeout = this.sessionTimeoutMs.get(memberId) ?? 10_000;
      if (now - member.lastSeenMs > timeout) stale.push(memberId);
    }
    if (stale.length === 0) return;
    for (const memberId of stale) group.stableMembers.delete(memberId);
    this.startRebalance(group);
  }

  /** Mirrors a real coordinator's `rebalance_timeout_ms`: once a forming generation's deadline
   * has passed, finalizes it without any `expected` member that still has not sent `JoinGroup` —
   * a member that stopped responding (crashed, partitioned) must not block the rest of the group
   * from ever rebalancing again. */
  private dropStragglersIfExpired(group: Group): void {
    const rebalance = group.rebalance;
    if (rebalance === undefined || this.now() < rebalance.deadlineMs) return;
    for (const memberId of [...rebalance.expected]) {
      if (!rebalance.joined.has(memberId)) rebalance.expected.delete(memberId);
    }
    this.maybeFinalizeJoin(group);
  }

  private startRebalance(group: Group, newMemberId?: string): void {
    const expected = new Set(group.stableMembers.keys());
    if (newMemberId !== undefined) expected.add(newMemberId);
    group.stableMembers.clear();
    group.sync = undefined;
    group.rebalance = {
      expected,
      joined: new Map(),
      joinOrder: [],
      deadlineMs: this.now() + this.rebalanceStragglerTimeoutMs,
    };
    // `dropStragglersIfExpired` is also checked reactively (at the top of `joinGroup`/
    // `heartbeat`), which is enough whenever *some* member is still sending requests. But a
    // round that every remaining member has already joined except one straggler has no other
    // request arriving to trigger that check — nobody is left to send one. Scheduling it here
    // directly against the clock finalizes the round once its deadline passes regardless.
    if (this.clock !== undefined) {
      this.clock.sleep(this.rebalanceStragglerTimeoutMs).then(
        () => this.dropStragglersIfExpired(group),
        () => undefined,
      );
    }
  }

  joinGroup(
    groupId: string,
    requestedMemberId: string,
    sessionTimeoutMs: number,
    offeredProtocols: readonly { name: string; metadata: Buffer }[],
    respond: JoinWaiter['respond'],
  ): void {
    const group = this.state.groupFor(groupId);
    this.sweepStale(group);
    this.dropStragglersIfExpired(group);

    let memberId = requestedMemberId;
    // A member rejoining mid-rebalance is "known" if it is a member this group already expects
    // to (re)join this generation — not just if it has already fully joined (`joined`) or is
    // still fully stable (`stableMembers`, which `startRebalance` clears up front) — otherwise a
    // legitimate rejoin using its own remembered ID would be mistaken for a brand-new member and
    // handed a different one, which `expected` (snapshotted before the clear) would then never
    // see rejoin.
    const isKnown =
      group.stableMembers.has(memberId) ||
      group.rebalance?.joined.has(memberId) === true ||
      group.rebalance?.expected.has(memberId) === true;
    if (memberId === '' || !isKnown) {
      memberId = `member-${++group.memberCounter}`;
    }
    this.sessionTimeoutMs.set(memberId, sessionTimeoutMs);

    if (group.rebalance === undefined) this.startRebalance(group, memberId);
    const rebalance = group.rebalance!;
    rebalance.expected.add(memberId);
    rebalance.joined.set(memberId, { offeredProtocols, respond });
    rebalance.joinOrder.push(memberId);
    this.maybeFinalizeJoin(group);
  }

  private maybeFinalizeJoin(group: Group): void {
    const rebalance = group.rebalance;
    if (rebalance === undefined) return;
    for (const memberId of rebalance.expected) {
      if (!rebalance.joined.has(memberId)) return; // still waiting on someone
    }

    const leaderId = rebalance.joinOrder[0]!;
    const leader = rebalance.joined.get(leaderId)!;
    let protocolName: string | undefined;
    for (const candidate of leader.offeredProtocols.map((p) => p.name)) {
      if (
        [...rebalance.joined.values()].every((m) =>
          m.offeredProtocols.some((p) => p.name === candidate),
        )
      ) {
        protocolName = candidate;
        break;
      }
    }

    group.generationId += 1;
    const generationId = group.generationId;
    const now = this.now();

    if (protocolName === undefined) {
      for (const [, member] of rebalance.joined) {
        member.respond({
          generationId,
          leader: leaderId,
          memberId: '',
          protocolName: '',
          members: [],
        });
      }
      group.rebalance = undefined;
      return;
    }

    const membersForLeader = [...rebalance.joined].map(([memberId, member]) => ({
      memberId,
      metadata: member.offeredProtocols.find((p) => p.name === protocolName)!.metadata,
    }));

    for (const [memberId, member] of rebalance.joined) {
      group.stableMembers.set(memberId, { lastSeenMs: now });
      member.respond({
        generationId,
        leader: leaderId,
        memberId,
        protocolName,
        members: memberId === leaderId ? membersForLeader : [],
      });
    }
    group.sync = {
      generationId,
      leaderId,
      protocolName,
      waiting: new Map(),
      assignments: undefined,
    };
    group.rebalance = undefined;
  }

  syncGroup(
    groupId: string,
    generationId: number,
    memberId: string,
    assignments: readonly { memberId: string; assignment: Buffer }[],
    respond: (errorCode: number, assignment: Buffer) => void,
  ): void {
    const group = this.state.groupFor(groupId);
    if (group.rebalance !== undefined && group.rebalance.expected.has(memberId)) {
      // This member is still mid-join for a newer generation (e.g. it heartbeat-triggered a
      // rejoin after already syncing once); nothing to sync against yet.
      respond(KafkaErrorCode.REBALANCE_IN_PROGRESS, Buffer.alloc(0));
      return;
    }
    if (group.sync === undefined || group.sync.generationId !== generationId) {
      respond(KafkaErrorCode.ILLEGAL_GENERATION, Buffer.alloc(0));
      return;
    }
    const sync = group.sync;
    if (memberId === sync.leaderId && assignments.length > 0) {
      sync.assignments = new Map(assignments.map((a) => [a.memberId, a.assignment]));
      for (const [waitingMemberId, resolve] of sync.waiting) {
        resolve(sync.assignments.get(waitingMemberId) ?? Buffer.alloc(0));
      }
      sync.waiting.clear();
      respond(0, sync.assignments.get(memberId) ?? Buffer.alloc(0));
      return;
    }
    if (sync.assignments !== undefined) {
      respond(0, sync.assignments.get(memberId) ?? Buffer.alloc(0));
      return;
    }
    sync.waiting.set(memberId, (assignment) => respond(0, assignment));
  }

  heartbeat(groupId: string, generationId: number, memberId: string): number {
    const group = this.state.groupFor(groupId);
    this.sweepStale(group);
    this.dropStragglersIfExpired(group);
    if (group.rebalance !== undefined) {
      if (!group.rebalance.joined.has(memberId)) return KafkaErrorCode.REBALANCE_IN_PROGRESS;
      // Already rejoined for the forming generation but hasn't synced yet; from this member's
      // point of view that is still "a rebalance is in progress".
      return KafkaErrorCode.REBALANCE_IN_PROGRESS;
    }
    const member = group.stableMembers.get(memberId);
    if (member === undefined) return KafkaErrorCode.UNKNOWN_MEMBER_ID;
    if (generationId !== group.generationId) return KafkaErrorCode.ILLEGAL_GENERATION;
    member.lastSeenMs = this.now();
    return KafkaErrorCode.NONE;
  }

  leaveGroup(groupId: string, memberId: string): void {
    const group = this.state.groupFor(groupId);
    if (!group.stableMembers.has(memberId)) return;
    group.stableMembers.delete(memberId);
    if (group.stableMembers.size === 0) {
      group.sync = undefined;
      return;
    }
    this.startRebalance(group);
  }

  offsetCommit(
    groupId: string,
    generationId: number,
    memberId: string,
    topics: readonly {
      name: string;
      partitions: readonly { partitionIndex: number; committedOffset: bigint }[];
    }[],
  ): { name: string; partitions: { partitionIndex: number; errorCode: number }[] }[] {
    const group = this.state.groupFor(groupId);
    const member = group.stableMembers.get(memberId);
    let errorCode: number = KafkaErrorCode.NONE;
    if (member === undefined) errorCode = KafkaErrorCode.UNKNOWN_MEMBER_ID;
    else if (generationId !== group.generationId) errorCode = KafkaErrorCode.ILLEGAL_GENERATION;

    return topics.map((topic) => ({
      name: topic.name,
      partitions: topic.partitions.map((partition) => {
        if (errorCode === KafkaErrorCode.NONE) {
          group.offsets.set(tpKey(topic.name, partition.partitionIndex), partition.committedOffset);
        }
        return { partitionIndex: partition.partitionIndex, errorCode };
      }),
    }));
  }

  offsetFetch(
    groupId: string,
    topics: readonly { name: string; partitionIndexes: readonly number[] }[],
  ): { name: string; partitions: { partitionIndex: number; committedOffset: bigint }[] }[] {
    const group = this.state.groupFor(groupId);
    return topics.map((topic) => ({
      name: topic.name,
      partitions: topic.partitionIndexes.map((partitionIndex) => ({
        partitionIndex,
        committedOffset: group.offsets.get(tpKey(topic.name, partitionIndex)) ?? -1n,
      })),
    }));
  }
}

class KafkaConnectionHandler {
  private readonly inbox: { apiKey: number; correlationId: number; body: Buffer }[] = [];
  private waiter:
    ((m: { apiKey: number; correlationId: number; body: Buffer }) => void) | undefined;
  private recvBuffer: Buffer = Buffer.alloc(0);

  constructor(
    private readonly socket: net.Socket,
    private readonly options: FakeGroupCoordinatorOptions,
    private readonly nodeId: number,
    private readonly selfPort: number,
    private readonly state: BrokerState,
    private readonly coordinator: GroupCoordinator,
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
      const correlationId = frame.readInt32BE(4);
      let offset = 8;
      const clientIdLen = frame.readInt16BE(offset);
      offset += 2;
      if (clientIdLen >= 0) offset += clientIdLen;
      if (FLEXIBLE_API_KEYS.has(apiKey)) offset += 1; // empty tagged-fields terminator
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
      case ApiKey.Metadata:
        this.handleMetadata(request.correlationId, request.body);
        return;
      case ApiKey.FindCoordinator:
        this.handleFindCoordinator(request.correlationId, request.body);
        return;
      case ApiKey.JoinGroup:
        this.handleJoinGroup(request.correlationId, request.body);
        return;
      case ApiKey.SyncGroup:
        this.handleSyncGroup(request.correlationId, request.body);
        return;
      case ApiKey.Heartbeat:
        this.handleHeartbeat(request.correlationId, request.body);
        return;
      case ApiKey.LeaveGroup:
        this.handleLeaveGroup(request.correlationId, request.body);
        return;
      case ApiKey.OffsetCommit:
        this.handleOffsetCommit(request.correlationId, request.body);
        return;
      case ApiKey.OffsetFetch:
        this.handleOffsetFetch(request.correlationId, request.body);
        return;
      case ApiKey.Fetch:
        this.handleFetch(request.correlationId, request.body);
        return;
      case ApiKey.ListOffsets:
        this.handleListOffsets(request.correlationId, request.body);
        return;
      default:
        return;
    }
  }

  private handleMetadata(correlationId: number, body: Buffer): void {
    const r = new KafkaReader(body);
    const topicCount = r.compactArrayLength();
    // `topicCount === -1` means the client sent a null topics array ("every topic the cluster
    // has", used to resolve a `topic_pattern`) — answered with this fake broker's own configured
    // topic list, since it has no other notion of "every topic" to draw from.
    const topics: string[] =
      topicCount === -1 ? Object.keys(this.options.partitionCounts ?? {}) : [];
    for (let i = 0; i < topicCount; i++) {
      topics.push(r.compactString());
      r.skipTaggedFields();
    }
    const w = new KafkaWriter();
    w.int32(0);
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
      writer.int16(0);
      writer.compactNullableString(topic);
      writer.boolean(false);
      const partitionCount = this.options.partitionCounts?.[topic] ?? 1;
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
      writer.int32(0);
      writer.emptyTaggedFields();
    });
    w.emptyTaggedFields();
    this.send(correlationId, w.build());
  }

  private handleFindCoordinator(correlationId: number, body: Buffer): void {
    const r = new KafkaReader(body);
    r.compactString(); // group id (this broker is always the coordinator; nothing to look up)
    r.int8(); // key_type
    r.skipTaggedFields();
    const w = new KafkaWriter();
    w.int32(0); // throttle_time_ms
    w.int16(0); // error_code
    w.compactNullableString(null); // error_message
    w.int32(this.nodeId);
    w.compactString('127.0.0.1');
    w.int32(this.selfPort);
    w.emptyTaggedFields();
    this.send(correlationId, w.build());
  }

  private handleJoinGroup(correlationId: number, body: Buffer): void {
    const r = new KafkaReader(body);
    const groupId = r.compactString();
    const sessionTimeoutMs = r.int32();
    r.int32(); // rebalance_timeout_ms
    const memberId = r.compactString();
    r.compactNullableString(); // group_instance_id
    r.compactNullableString(); // protocol_type
    const protocolCount = r.compactArrayLength();
    const offeredProtocols: { name: string; metadata: Buffer }[] = [];
    for (let i = 0; i < protocolCount; i++) {
      const name = r.compactString();
      const metadata = r.compactNullableBytes() ?? Buffer.alloc(0);
      r.skipTaggedFields();
      offeredProtocols.push({ name, metadata });
    }
    r.skipTaggedFields();

    this.coordinator.joinGroup(groupId, memberId, sessionTimeoutMs, offeredProtocols, (result) => {
      const w = new KafkaWriter();
      w.int32(0); // throttle_time_ms
      w.int16(result.protocolName === '' ? KafkaErrorCode.INVALID_TOPIC_EXCEPTION : 0);
      w.int32(result.generationId);
      w.compactNullableString('consumer');
      w.compactNullableString(result.protocolName === '' ? null : result.protocolName);
      w.compactString(result.leader);
      w.compactString(result.memberId);
      w.compactArray(result.members, (mw, member) => {
        mw.compactString(member.memberId);
        mw.compactNullableString(null); // group_instance_id
        mw.compactNullableBytes(member.metadata);
        mw.emptyTaggedFields();
      });
      w.emptyTaggedFields();
      this.send(correlationId, w.build());
    });
  }

  private handleSyncGroup(correlationId: number, body: Buffer): void {
    const r = new KafkaReader(body);
    const groupId = r.compactString();
    const generationId = r.int32();
    const memberId = r.compactString();
    r.compactNullableString(); // group_instance_id
    r.compactNullableString(); // protocol_type
    r.compactNullableString(); // protocol_name
    const assignmentCount = r.compactArrayLength();
    const assignments: { memberId: string; assignment: Buffer }[] = [];
    for (let i = 0; i < assignmentCount; i++) {
      const assignMemberId = r.compactString();
      const assignment = r.compactNullableBytes() ?? Buffer.alloc(0);
      r.skipTaggedFields();
      assignments.push({ memberId: assignMemberId, assignment });
    }
    r.skipTaggedFields();

    this.coordinator.syncGroup(
      groupId,
      generationId,
      memberId,
      assignments,
      (errorCode, assignment) => {
        const w = new KafkaWriter();
        w.int32(0); // throttle_time_ms
        w.int16(errorCode);
        w.compactNullableString(errorCode === 0 ? 'consumer' : null);
        w.compactNullableString(errorCode === 0 ? 'range' : null);
        w.compactNullableBytes(assignment);
        w.emptyTaggedFields();
        this.send(correlationId, w.build());
      },
    );
  }

  private handleHeartbeat(correlationId: number, body: Buffer): void {
    const r = new KafkaReader(body);
    const groupId = r.compactString();
    const generationId = r.int32();
    const memberId = r.compactString();
    r.compactNullableString();
    r.skipTaggedFields();
    const errorCode = this.coordinator.heartbeat(groupId, generationId, memberId);
    const w = new KafkaWriter();
    w.int32(0);
    w.int16(errorCode);
    w.emptyTaggedFields();
    this.send(correlationId, w.build());
  }

  private handleLeaveGroup(correlationId: number, body: Buffer): void {
    const r = new KafkaReader(body);
    const groupId = r.compactString();
    const memberCount = r.compactArrayLength();
    const memberIds: string[] = [];
    for (let i = 0; i < memberCount; i++) {
      memberIds.push(r.compactString());
      r.compactNullableString();
      r.skipTaggedFields();
    }
    r.skipTaggedFields();
    for (const memberId of memberIds) this.coordinator.leaveGroup(groupId, memberId);
    const w = new KafkaWriter();
    w.int32(0);
    w.int16(0);
    w.compactArray(memberIds, (mw, memberId) => {
      mw.compactString(memberId);
      mw.compactNullableString(null);
      mw.int16(0);
      mw.emptyTaggedFields();
    });
    w.emptyTaggedFields();
    this.send(correlationId, w.build());
  }

  private handleOffsetCommit(correlationId: number, body: Buffer): void {
    const r = new KafkaReader(body);
    const groupId = r.compactString();
    const generationId = r.int32();
    const memberId = r.compactString();
    r.compactNullableString();
    const topicCount = r.compactArrayLength();
    const topics: {
      name: string;
      partitions: { partitionIndex: number; committedOffset: bigint }[];
    }[] = [];
    for (let t = 0; t < topicCount; t++) {
      const name = r.compactString();
      const partitionCount = r.compactArrayLength();
      const partitions: { partitionIndex: number; committedOffset: bigint }[] = [];
      for (let p = 0; p < partitionCount; p++) {
        const partitionIndex = r.int32();
        const committedOffset = r.int64();
        r.int32(); // committed_leader_epoch
        r.compactNullableString(); // committed_metadata
        r.skipTaggedFields();
        partitions.push({ partitionIndex, committedOffset });
      }
      r.skipTaggedFields();
      topics.push({ name, partitions });
    }
    r.skipTaggedFields();

    const result = this.coordinator.offsetCommit(groupId, generationId, memberId, topics);
    const w = new KafkaWriter();
    w.int32(0);
    w.compactArray(result, (tw, topic) => {
      tw.compactString(topic.name);
      tw.compactArray(topic.partitions, (pw, partition) => {
        pw.int32(partition.partitionIndex);
        pw.int16(partition.errorCode);
        pw.emptyTaggedFields();
      });
      tw.emptyTaggedFields();
    });
    w.emptyTaggedFields();
    this.send(correlationId, w.build());
  }

  private handleOffsetFetch(correlationId: number, body: Buffer): void {
    const r = new KafkaReader(body);
    const groupId = r.compactString();
    const topicCount = r.compactArrayLength();
    const topics: { name: string; partitionIndexes: number[] }[] = [];
    for (let t = 0; t < topicCount; t++) {
      const name = r.compactString();
      const partitionCount = r.compactArrayLength();
      const partitionIndexes: number[] = [];
      for (let p = 0; p < partitionCount; p++) partitionIndexes.push(r.int32());
      r.skipTaggedFields();
      topics.push({ name, partitionIndexes });
    }
    r.skipTaggedFields();

    const result = this.coordinator.offsetFetch(groupId, topics);
    const w = new KafkaWriter();
    w.int32(0);
    w.compactArray(result, (tw, topic) => {
      tw.compactString(topic.name);
      tw.compactArray(topic.partitions, (pw, partition) => {
        pw.int32(partition.partitionIndex);
        pw.int64(partition.committedOffset);
        pw.int32(-1); // committed_leader_epoch
        pw.compactNullableString(null); // metadata
        pw.int16(0); // error_code
        pw.emptyTaggedFields();
      });
      tw.emptyTaggedFields();
    });
    w.int16(0); // top-level error_code
    w.emptyTaggedFields();
    this.send(correlationId, w.build());
  }

  private handleFetch(correlationId: number, body: Buffer): void {
    const r = new KafkaReader(body);
    r.int32(); // replica_id
    const maxWaitMs = r.int32();
    r.int32(); // min_bytes
    r.int32(); // max_bytes
    r.int8(); // isolation_level
    r.int32(); // session_id
    r.int32(); // session_epoch
    const topicCount = r.compactArrayLength();
    const topics: { topic: string; partitions: { partition: number; fetchOffset: bigint }[] }[] =
      [];
    for (let t = 0; t < topicCount; t++) {
      const topic = r.compactString();
      const partitionCount = r.compactArrayLength();
      const partitions: { partition: number; fetchOffset: bigint }[] = [];
      for (let p = 0; p < partitionCount; p++) {
        const partition = r.int32();
        r.int32(); // current_leader_epoch
        const fetchOffset = r.int64();
        r.int32(); // last_fetched_epoch
        r.int64(); // log_start_offset
        r.int32(); // partition_max_bytes
        r.skipTaggedFields();
        partitions.push({ partition, fetchOffset });
      }
      r.skipTaggedFields();
      topics.push({ topic, partitions });
    }
    r.compactArrayLength(); // forgotten_topics_data (always empty from this client)
    r.compactString(); // rack_id
    r.skipTaggedFields();

    void this.respondToFetch(correlationId, topics, maxWaitMs);
  }

  /** Whether any requested partition already has something to answer with right now: new
   * records at or past its fetch offset, or an out-of-range condition (an error is itself a
   * ready answer, not something to wait out). */
  private fetchHasReadyData(
    topics: readonly {
      topic: string;
      partitions: readonly { partition: number; fetchOffset: bigint }[];
    }[],
  ): boolean {
    for (const topicReq of topics) {
      for (const partitionReq of topicReq.partitions) {
        const log = this.state.logFor(topicReq.topic, partitionReq.partition);
        const logStartOffset = log.baseOffsets[0] ?? 0n;
        if (
          partitionReq.fetchOffset > log.nextOffset ||
          partitionReq.fetchOffset < logStartOffset
        ) {
          return true;
        }
        for (const baseOffset of log.baseOffsets) {
          if (baseOffset >= partitionReq.fetchOffset) return true;
        }
      }
    }
    return false;
  }

  /** Real long-polling, like an actual broker's `Fetch` handling: if nothing requested has new
   * data yet, this holds the response — checking every 10ms, real wall-clock time rather than
   * the injected session-timeout clock — until something does, or `maxWaitMs` elapses, instead
   * of answering empty immediately. Without this, a consumer whose own poll loop has no other
   * pacing of its own (this client's documented usage is a tight `for (;;) { await poll(); }`,
   * relying entirely on a real broker's long-poll to avoid spinning) would busy-loop against
   * this fake broker the moment there is nothing new to fetch. */
  private async respondToFetch(
    correlationId: number,
    topics: readonly {
      topic: string;
      partitions: readonly { partition: number; fetchOffset: bigint }[];
    }[],
    maxWaitMs: number,
  ): Promise<void> {
    const deadline = Date.now() + Math.max(0, maxWaitMs);
    while (!this.fetchHasReadyData(topics) && Date.now() < deadline) {
      await new Promise<void>((resolve) => setTimeout(resolve, 10));
    }

    const w = new KafkaWriter();
    w.int32(0); // throttle_time_ms
    w.int16(0); // error_code
    w.int32(0); // session_id
    w.compactArray(topics, (tw, topicReq) => {
      tw.compactString(topicReq.topic);
      tw.compactArray(topicReq.partitions, (pw, partitionReq) => {
        const log = this.state.logFor(topicReq.topic, partitionReq.partition);
        const logStartOffset = log.baseOffsets[0] ?? 0n;
        // A real broker rejects a fetch offset outside the log's current bounds (e.g. a stale
        // committed offset after retention deleted the data, or — since this fake log never
        // actually deletes anything — simply a caller-supplied offset past the end of the log)
        // with OFFSET_OUT_OF_RANGE rather than silently returning nothing, which is what a
        // consumer's `auto_offset_reset` handling (via ListOffsets) needs to see to kick in.
        const outOfRange =
          partitionReq.fetchOffset > log.nextOffset || partitionReq.fetchOffset < logStartOffset;
        const matching: Buffer[] = [];
        if (!outOfRange) {
          for (let i = 0; i < log.batches.length; i++) {
            if (log.baseOffsets[i]! >= partitionReq.fetchOffset) matching.push(log.batches[i]!);
          }
        }
        const records = matching.length === 0 ? null : Buffer.concat(matching);
        pw.int32(partitionReq.partition);
        pw.int16(outOfRange ? KafkaErrorCode.OFFSET_OUT_OF_RANGE : 0);
        pw.int64(log.nextOffset); // high_watermark
        pw.int64(log.nextOffset); // last_stable_offset
        pw.int64(logStartOffset);
        pw.compactArray(log.abortedTransactions, (aw, aborted) => {
          aw.int64(aborted.producerId);
          aw.int64(aborted.firstOffset);
          aw.emptyTaggedFields();
        });
        pw.int32(-1); // preferred_read_replica
        pw.compactNullableBytes(records);
        pw.emptyTaggedFields();
      });
      tw.emptyTaggedFields();
    });
    w.emptyTaggedFields();
    this.send(correlationId, w.build());
  }

  /** `ListOffsets` (classic, non-flexible): resolves the special `EARLIEST`/`LATEST` timestamps
   * (`-2`/`-1`) a consumer's `auto_offset_reset` policy sends against this fake log's actual
   * bounds — any other timestamp value is answered with `LATEST`'s offset, since no test needs
   * this broker to support a real timestamp-based search. */
  private handleListOffsets(correlationId: number, body: Buffer): void {
    const r = new KafkaReader(body);
    r.int32(); // replica_id
    const topicCount = r.arrayLength();
    const topics: { name: string; partitions: { partitionIndex: number; timestamp: bigint }[] }[] =
      [];
    for (let t = 0; t < topicCount; t++) {
      const name = r.string();
      const partitionCount = r.arrayLength();
      const partitions: { partitionIndex: number; timestamp: bigint }[] = [];
      for (let p = 0; p < partitionCount; p++) {
        const partitionIndex = r.int32();
        const timestamp = r.int64();
        partitions.push({ partitionIndex, timestamp });
      }
      topics.push({ name, partitions });
    }

    const w = new KafkaWriter();
    w.array(topics, (tw, topicReq) => {
      tw.string(topicReq.name);
      tw.array(topicReq.partitions, (pw, partitionReq) => {
        const log = this.state.logFor(topicReq.name, partitionReq.partitionIndex);
        const earliest = log.baseOffsets[0] ?? 0n;
        const offset = partitionReq.timestamp === -2n ? earliest : log.nextOffset;
        pw.int32(partitionReq.partitionIndex);
        pw.int16(0); // error_code
        pw.int64(-1n); // timestamp: unused by this client
        pw.int64(offset);
      });
    });
    this.send(correlationId, w.build());
  }
}

export class FakeGroupCoordinatorBroker {
  private readonly server: net.Server;
  private _port = 0;
  readonly nodeId: number;
  private readonly state = new BrokerState();
  private readonly coordinator: GroupCoordinator;
  private readonly sessionTimeoutMs = new Map<string, number>();
  /** Every socket this server has accepted, so `close()` can forcibly tear down any a test
   * deliberately left open (a "silent member" simulation) — `net.Server.close()`'s callback
   * otherwise only fires once every connection closes on its own, which such a socket never
   * will — rather than waiting for them. */
  private readonly sockets = new Set<net.Socket>();

  constructor(private readonly options: FakeGroupCoordinatorOptions = {}) {
    this.nodeId = options.nodeId ?? 1;
    this.coordinator = new GroupCoordinator(
      this.state,
      options.clock,
      this.sessionTimeoutMs,
      options.rebalanceStragglerTimeoutMs ?? 2_000,
    );
    this.server = net.createServer((socket) => {
      this.sockets.add(socket);
      socket.once('close', () => this.sockets.delete(socket));
      const handler = new KafkaConnectionHandler(
        socket,
        this.options,
        this.nodeId,
        this._port,
        this.state,
        this.coordinator,
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

  /** Appends a pre-encoded RecordBatch to `topic`-`partition`'s in-memory log, returning the
   * base offset it was assigned (the log's current length), for a test to assert against. */
  appendRecords(
    topic: string,
    partition: number,
    records: readonly RecordInput[],
    options: {
      readonly compression?: 'none' | 'gzip';
      readonly isTransactional?: boolean;
      readonly isControl?: boolean;
      readonly producerId?: bigint;
    } = {},
  ): bigint {
    const log = this.state.logFor(topic, partition);
    const baseOffset = log.nextOffset;
    const encoded = encodeRecordBatch(records, { baseOffset, ...options });
    log.batches.push(encoded);
    log.baseOffsets.push(baseOffset);
    log.nextOffset = baseOffset + BigInt(records.length);
    return baseOffset;
  }

  /** Marks the open transaction for `producerId` on `topic`-`partition`, starting at
   * `firstOffset`, as aborted: a `read_committed` Fetch response will report it in
   * `aborted_transactions`, and the consumer skips every transactional batch from that producer
   * at or after `firstOffset` until the matching control batch (appended separately via
   * `appendRecords(..., { isControl: true })`) closes the window. */
  markAborted(topic: string, partition: number, producerId: bigint, firstOffset: bigint): void {
    this.state.logFor(topic, partition).abortedTransactions.push({ producerId, firstOffset });
  }

  /** Flips the last byte of the most recently appended batch on `topic`-`partition`, so its
   * CRC-32C no longer matches — for tests asserting that a Fetch response's decode path surfaces
   * a mismatch as `KafkaCrcError` rather than silently returning corrupted records. */
  corruptLastBatch(topic: string, partition: number): void {
    const log = this.state.logFor(topic, partition);
    const batch = log.batches[log.batches.length - 1];
    if (batch === undefined) throw new Error(`no batch appended yet for ${topic}-${partition}`);
    batch[batch.length - 1] = (batch[batch.length - 1]! + 1) & 0xff;
  }

  /** This group's actual committed offset for `topic`-`partition` as this broker holds it right
   * now (`undefined` if nothing has ever been committed) — for assertions, bypassing the
   * client-side round trip an `OffsetFetch` call would otherwise require. */
  committedOffset(groupId: string, topic: string, partition: number): bigint | undefined {
    return this.state.groups.get(groupId)?.offsets.get(tpKey(topic, partition));
  }

  async close(): Promise<void> {
    await new Promise<void>((resolve) => {
      this.server.close(() => resolve());
      for (const socket of this.sockets) socket.destroy();
    });
  }
}
