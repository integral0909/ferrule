import { describe, expect, it } from 'vitest';
import {
  cooperativeStickyAssignor,
  rangeAssignor,
  type AssignorSubscription,
  type TopicPartitions,
} from '../../src/kafka/assignors.js';

function sub(
  topics: readonly string[],
  ownedPartitions: readonly TopicPartitions[] = [],
): AssignorSubscription {
  return { topics, ownedPartitions };
}

function totalAssigned(assignment: ReadonlyMap<string, TopicPartitions[]>): number {
  let total = 0;
  for (const tps of assignment.values()) for (const tp of tps) total += tp.partitions.length;
  return total;
}

function flattenAssignment(
  assignment: ReadonlyMap<string, TopicPartitions[]>,
): Map<string, string> {
  const owner = new Map<string, string>();
  for (const [memberId, tps] of assignment) {
    for (const tp of tps) {
      for (const partition of tp.partitions) owner.set(`${tp.topic}:${partition}`, memberId);
    }
  }
  return owner;
}

describe('rangeAssignor', () => {
  it('gives a single member every partition of its subscribed topic', () => {
    const result = rangeAssignor.assign(
      new Map([['m1', sub(['events'])]]),
      new Map([['events', 4]]),
    );
    expect(result.get('m1')).toEqual([{ topic: 'events', partitions: [0, 1, 2, 3] }]);
  });

  it('splits an evenly-divisible topic equally between two members, sorted by member id', () => {
    const result = rangeAssignor.assign(
      new Map([
        ['b', sub(['events'])],
        ['a', sub(['events'])],
      ]),
      new Map([['events', 4]]),
    );
    expect(result.get('a')).toEqual([{ topic: 'events', partitions: [0, 1] }]);
    expect(result.get('b')).toEqual([{ topic: 'events', partitions: [2, 3] }]);
  });

  it('gives the remainder to the earliest members in sorted order', () => {
    const result = rangeAssignor.assign(
      new Map([
        ['c', sub(['events'])],
        ['a', sub(['events'])],
        ['b', sub(['events'])],
      ]),
      new Map([['events', 5]]),
    );
    // 5 partitions / 3 members = 1 each + 2 remainder -> a and b get 2, c gets 1.
    expect(result.get('a')).toEqual([{ topic: 'events', partitions: [0, 1] }]);
    expect(result.get('b')).toEqual([{ topic: 'events', partitions: [2, 3] }]);
    expect(result.get('c')).toEqual([{ topic: 'events', partitions: [4] }]);
  });

  it('never assigns a partition to a member not subscribed to its topic', () => {
    const result = rangeAssignor.assign(
      new Map([
        ['m1', sub(['events'])],
        ['m2', sub(['other'])],
      ]),
      new Map([
        ['events', 2],
        ['other', 2],
      ]),
    );
    expect(result.get('m1')).toEqual([{ topic: 'events', partitions: [0, 1] }]);
    expect(result.get('m2')).toEqual([{ topic: 'other', partitions: [0, 1] }]);
  });

  it('assigns nothing for a topic with no partition-count metadata yet', () => {
    const result = rangeAssignor.assign(new Map([['m1', sub(['missing'])]]), new Map());
    expect(result.get('m1')).toEqual([]);
  });

  it('every partition goes to exactly one member (no duplicates, nothing dropped)', () => {
    const result = rangeAssignor.assign(
      new Map([
        ['a', sub(['t'])],
        ['b', sub(['t'])],
        ['c', sub(['t'])],
      ]),
      new Map([['t', 7]]),
    );
    expect(totalAssigned(result)).toBe(7);
    const owners = flattenAssignment(result);
    expect(owners.size).toBe(7);
  });
});

describe('cooperativeStickyAssignor: initial assignment (no prior ownership)', () => {
  it('balances a topic evenly across two fresh members', () => {
    const result = cooperativeStickyAssignor.assign(
      new Map([
        ['a', sub(['events'])],
        ['b', sub(['events'])],
      ]),
      new Map([['events', 4]]),
    );
    expect(totalAssigned(result)).toBe(4);
    expect(result.get('a')!.flatMap((tp) => tp.partitions)).toHaveLength(2);
    expect(result.get('b')!.flatMap((tp) => tp.partitions)).toHaveLength(2);
  });

  it('every partition goes to exactly one eligible member', () => {
    const result = cooperativeStickyAssignor.assign(
      new Map([
        ['a', sub(['t'])],
        ['b', sub(['t'])],
        ['c', sub(['t'])],
      ]),
      new Map([['t', 10]]),
    );
    expect(totalAssigned(result)).toBe(10);
    expect(flattenAssignment(result).size).toBe(10);
  });
});

describe('cooperativeStickyAssignor: stability', () => {
  it('reassigns nothing when membership and ownership are unchanged', () => {
    const subscriptions = new Map([
      ['a', sub(['events'], [{ topic: 'events', partitions: [0, 1] }])],
      ['b', sub(['events'], [{ topic: 'events', partitions: [2, 3] }])],
    ]);
    const result = cooperativeStickyAssignor.assign(subscriptions, new Map([['events', 4]]));
    expect(result.get('a')).toEqual([{ topic: 'events', partitions: [0, 1] }]);
    expect(result.get('b')).toEqual([{ topic: 'events', partitions: [2, 3] }]);
  });
});

describe('cooperativeStickyAssignor: a member joins mid-stream (incremental revocation)', () => {
  it('round 1 revokes the moving partition from its old owner without yet giving it to the new member', () => {
    // Two members evenly own 4 partitions; a third joins, so on perfect balance each should end
    // up with 4/3 ~ 1-2 partitions. Round 1 must not assign anything new to the joining member at
    // the expense of an existing owner within the same generation.
    const round1 = cooperativeStickyAssignor.assign(
      new Map([
        ['a', sub(['events'], [{ topic: 'events', partitions: [0, 1] }])],
        ['b', sub(['events'], [{ topic: 'events', partitions: [2, 3] }])],
        ['c', sub(['events'], [])], // new member, owns nothing yet
      ]),
      new Map([['events', 4]]),
    );
    const owners1 = flattenAssignment(round1);
    // Nothing assigned to c yet in round 1: whatever moves away from a/b is left unassigned.
    expect(round1.get('c')).toEqual([]);
    // Every partition that round 1 *does* assign is assigned to its original owner (stickiness):
    // nothing is handed directly from a to b or vice versa.
    for (const [key, owner] of owners1) {
      const partition = Number(key.split(':')[1]);
      if (owner === 'a') expect([0, 1]).toContain(partition);
      if (owner === 'b') expect([2, 3]).toContain(partition);
    }
    // At least one partition must have been revoked (left unassigned) to make room for c.
    expect(owners1.size).toBeLessThan(4);
  });

  it('round 2 (after the revoking owner reports the partition as no longer owned) gives it to the new member', () => {
    const round1 = cooperativeStickyAssignor.assign(
      new Map([
        ['a', sub(['events'], [{ topic: 'events', partitions: [0, 1] }])],
        ['b', sub(['events'], [{ topic: 'events', partitions: [2, 3] }])],
        ['c', sub(['events'], [])],
      ]),
      new Map([['events', 4]]),
    );
    // Simulate every member reporting round 1's actual result as their new ownedPartitions.
    const round2 = cooperativeStickyAssignor.assign(
      new Map([
        ['a', sub(['events'], round1.get('a'))],
        ['b', sub(['events'], round1.get('b'))],
        ['c', sub(['events'], round1.get('c'))],
      ]),
      new Map([['events', 4]]),
    );
    expect(totalAssigned(round2)).toBe(4);
    expect(round2.get('c')!.flatMap((tp) => tp.partitions).length).toBeGreaterThan(0);
    // The whole group is now (close to) balanced: max - min <= 1.
    const counts = ['a', 'b', 'c'].map((m) => round2.get(m)!.flatMap((tp) => tp.partitions).length);
    expect(Math.max(...counts) - Math.min(...counts)).toBeLessThanOrEqual(1);
  });
});

describe('cooperativeStickyAssignor: a member leaves mid-stream', () => {
  it('redistributes the departed member’s partitions to the remaining members in a single round', () => {
    // b owned partitions 2 and 3; it is gone (not in the subscriptions map at all), so those
    // partitions have no current owner and can be handed out immediately — no revocation phase
    // is needed since there is no live owner to revoke from.
    const result = cooperativeStickyAssignor.assign(
      new Map([['a', sub(['events'], [{ topic: 'events', partitions: [0, 1] }])]]),
      new Map([['events', 4]]),
    );
    expect(totalAssigned(result)).toBe(4);
    const owned = result.get('a')!.flatMap((tp) => tp.partitions);
    expect(owned).toEqual(expect.arrayContaining([0, 1]));
    expect(owned).toHaveLength(4);
  });
});
