/**
 * Partition assignors: pure functions from "who is in the group, subscribed to what, currently
 * holding what" to "who should hold what" — the computation the group's elected leader runs
 * once per generation (see `consumer.ts`) and sends to the coordinator via `SyncGroup`. Neither
 * assignor here touches the network or any mutable client state; both are plain functions over
 * their inputs, matching this codebase's general preference for pure computation wherever
 * state is not strictly needed.
 */

export interface AssignorSubscription {
  readonly topics: readonly string[];
  /** What this member's own `ConsumerProtocolSubscription` claimed it currently owns — only
   * meaningful to {@link cooperativeStickyAssignor}; {@link rangeAssignor} ignores it entirely,
   * matching the "eager" rebalance protocol's semantics (every member revokes everything before
   * rejoining, so there is nothing to be sticky about). */
  readonly ownedPartitions: readonly TopicPartitions[];
}

export interface TopicPartitions {
  readonly topic: string;
  readonly partitions: readonly number[];
}

export interface Assignor {
  readonly name: string;
  /**
   * @param subscriptions memberId -> that member's subscription.
   * @param partitionCounts topic -> how many partitions it has (from Metadata). A topic absent
   * here is treated as not existing yet (e.g. auto-creation hasn't happened), so no partitions
   * of it are assigned to anyone this round.
   * @returns memberId -> that member's assignment for *this* generation. For
   * {@link cooperativeStickyAssignor}, a partition moving from one member to another is omitted
   * from *both* members' assignment in the generation where the move is decided (the old owner
   * must revoke it locally and rejoin before the new owner receives it in the *next*
   * generation) — see the module comment on `consumer-protocol.ts` and `consumer.ts`'s handling
   * of `REBALANCE_IN_PROGRESS`.
   */
  assign(
    subscriptions: ReadonlyMap<string, AssignorSubscription>,
    partitionCounts: ReadonlyMap<string, number>,
  ): Map<string, TopicPartitions[]>;
}

function appendAssignment(
  result: Map<string, TopicPartitions[]>,
  memberId: string,
  topic: string,
  partition: number,
): void {
  const list = result.get(memberId);
  if (list === undefined) return;
  const existing = list.find((tp) => tp.topic === topic);
  if (existing === undefined) {
    list.push({ topic, partitions: [partition] });
  } else {
    (existing.partitions as number[]).push(partition);
  }
}

/**
 * The classic range assignor (Kafka's `RangeAssignor`): per topic, every subscribed member
 * (sorted by member ID) gets a contiguous, roughly-equal slice of that topic's partitions, with
 * any remainder (`numPartitions % numMembers`) going one each to the earliest members in sorted
 * order. Stateless and non-sticky — a rebalance recomputes every member's assignment from
 * scratch, matching the "eager" protocol this assignor is normally paired with (every member
 * revokes everything it holds before rejoining).
 */
export const rangeAssignor: Assignor = {
  name: 'range',

  assign(subscriptions, partitionCounts) {
    const result = new Map<string, TopicPartitions[]>();
    for (const memberId of subscriptions.keys()) result.set(memberId, []);

    const membersByTopic = new Map<string, string[]>();
    for (const [memberId, sub] of subscriptions) {
      for (const topic of sub.topics) {
        if (!partitionCounts.has(topic)) continue;
        let members = membersByTopic.get(topic);
        if (members === undefined) {
          members = [];
          membersByTopic.set(topic, members);
        }
        members.push(memberId);
      }
    }

    for (const [topic, members] of membersByTopic) {
      members.sort();
      const numPartitions = partitionCounts.get(topic) ?? 0;
      const numMembers = members.length;
      if (numMembers === 0 || numPartitions === 0) continue;
      const base = Math.floor(numPartitions / numMembers);
      const extra = numPartitions % numMembers;
      let nextPartition = 0;
      for (let i = 0; i < numMembers; i++) {
        const count = base + (i < extra ? 1 : 0);
        if (count === 0) continue;
        const partitions: number[] = [];
        for (let k = 0; k < count; k++) partitions.push(nextPartition++);
        result.get(members[i]!)!.push({ topic, partitions });
      }
    }
    return result;
  },
};

function partitionKey(topic: string, partition: number): string {
  return `${topic}\u0001${partition}`;
}

function splitPartitionKey(key: string): { topic: string; partition: number } {
  const sep = key.lastIndexOf('\u0001');
  return { topic: key.slice(0, sep), partition: Number(key.slice(sep + 1)) };
}

/** Picks the least-loaded member among `eligible`, breaking ties by member ID for a
 * deterministic result regardless of iteration order. */
function pickLeastLoaded(eligible: readonly string[], load: ReadonlyMap<string, number>): string {
  let best = eligible[0]!;
  for (const candidate of eligible) {
    const bestLoad = load.get(best) ?? 0;
    const candidateLoad = load.get(candidate) ?? 0;
    if (candidateLoad < bestLoad || (candidateLoad === bestLoad && candidate < best)) {
      best = candidate;
    }
  }
  return best;
}

/**
 * KIP-429's cooperative-sticky assignor: like {@link rangeAssignor}, balances partitions evenly
 * across eligible members, but (a) is sticky — a member that already validly owns a partition
 * (per its `ownedPartitions`) keeps it unless rebalancing it elsewhere is needed for balance —
 * and (b) supports the "cooperative" incremental-rebalancing protocol: when balance requires
 * moving a partition from member A to member B, this generation's assignment omits it from
 * *both* A and B (A must revoke it locally; B does not receive it yet). Once A has rejoined
 * without it (reporting it as no longer owned), the *next* call to this function — for the next
 * generation — sees that partition as unowned and assigns it directly to B, no further deferral
 * needed. This two-generation handoff is what lets a cooperative group rebalance without any
 * member ever stopping consumption of partitions it keeps, unlike the eager protocol's
 * "revoke everything, then reassign" cycle.
 *
 * The balancing pass is a greedy repeated max/min swap (move one partition from the most-loaded
 * member to the least-loaded member eligible for it, repeat), not Kafka's exact sticky
 * optimizer. It reaches the same balanced result for the common case this client is built
 * for — every member in a group subscribes to the same topic set — but may stop one or two
 * partitions short of perfectly even when members have unusual, only-partially-overlapping
 * subscriptions.
 */
export const cooperativeStickyAssignor: Assignor = {
  name: 'cooperative-sticky',

  assign(subscriptions, partitionCounts) {
    const memberIds = [...subscriptions.keys()].sort();
    const result = new Map<string, TopicPartitions[]>();
    for (const memberId of memberIds) result.set(memberId, []);
    if (memberIds.length === 0) return result;

    const subscribedTopics = new Set<string>();
    for (const sub of subscriptions.values()) for (const topic of sub.topics) subscribedTopics.add(topic);

    const allPartitions: string[] = [];
    for (const topic of subscribedTopics) {
      const count = partitionCounts.get(topic) ?? 0;
      for (let p = 0; p < count; p++) allPartitions.push(partitionKey(topic, p));
    }
    const allPartitionSet = new Set(allPartitions);

    const eligibleMembers = new Map<string, string[]>();
    for (const key of allPartitions) {
      const { topic } = splitPartitionKey(key);
      eligibleMembers.set(
        key,
        memberIds.filter((m) => subscriptions.get(m)!.topics.includes(topic)),
      );
    }

    // Valid current ownership, from each member's reported ConsumerProtocolSubscription: drop
    // anything for a partition that no longer exists or a topic the member no longer
    // subscribes to, and resolve a double-claim (two members reporting the same partition —
    // should not happen against a correct broker, but a member that crashed and restarted
    // mid-rebalance could still report stale state) by keeping only the first member in sorted
    // order; the loser simply does not get credit for "already owning" it; sticky, not a
    // correctness issue.
    const currentOwner = new Map<string, string>();
    for (const memberId of memberIds) {
      const sub = subscriptions.get(memberId)!;
      for (const tp of sub.ownedPartitions) {
        if (!sub.topics.includes(tp.topic)) continue;
        for (const p of tp.partitions) {
          const key = partitionKey(tp.topic, p);
          if (!allPartitionSet.has(key)) continue;
          if (!currentOwner.has(key)) currentOwner.set(key, memberId);
        }
      }
    }

    // Baseline target keeps every valid current owner (stickiness)...
    const targetOwner = new Map(currentOwner);
    const load = new Map<string, number>(memberIds.map((m) => [m, 0]));
    for (const owner of targetOwner.values()) load.set(owner, (load.get(owner) ?? 0) + 1);

    // ...then every partition nobody currently (validly) owns goes to whichever eligible member
    // is least loaded so far.
    for (const key of allPartitions) {
      if (targetOwner.has(key)) continue;
      const eligible = eligibleMembers.get(key) ?? [];
      if (eligible.length === 0) continue; // no current subscriber wants this topic
      const chosen = pickLeastLoaded(eligible, load);
      targetOwner.set(key, chosen);
      load.set(chosen, (load.get(chosen) ?? 0) + 1);
    }

    // Balance pass: move one partition at a time from the most- to the least-loaded member,
    // whenever the least-loaded member is eligible for one of the most-loaded member's
    // partitions, until the spread is at most 1 or no further eligible move exists.
    const maxMoves = allPartitions.length * memberIds.length + 8;
    for (let iteration = 0; iteration < maxMoves; iteration++) {
      const sorted = [...memberIds].sort(
        (a, b) => (load.get(a) ?? 0) - (load.get(b) ?? 0) || a.localeCompare(b),
      );
      const minMember = sorted[0]!;
      const maxMember = sorted[sorted.length - 1]!;
      if ((load.get(maxMember) ?? 0) - (load.get(minMember) ?? 0) < 2) break;
      let moved = false;
      for (const [key, owner] of targetOwner) {
        if (owner !== maxMember) continue;
        if (!(eligibleMembers.get(key) ?? []).includes(minMember)) continue;
        targetOwner.set(key, minMember);
        load.set(maxMember, (load.get(maxMember) ?? 0) - 1);
        load.set(minMember, (load.get(minMember) ?? 0) + 1);
        moved = true;
        break;
      }
      if (!moved) break; // the current extremes share no movable, eligible partition
    }

    // Materialize this generation's assignment, deferring any partition whose owner is
    // genuinely changing (present in currentOwner under a different member than targetOwner):
    // it is left unassigned to anyone this round so the old owner revokes and the new owner
    // picks it up next generation.
    for (const key of allPartitions) {
      const target = targetOwner.get(key);
      if (target === undefined) continue;
      const previous = currentOwner.get(key);
      if (previous !== undefined && previous !== target) continue; // deferred to next generation
      const { topic, partition } = splitPartitionKey(key);
      appendAssignment(result, target, topic, partition);
    }
    return result;
  },
};
