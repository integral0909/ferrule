import { describe, expect, it } from 'vitest';
import {
  decodeConsumerProtocolAssignment,
  decodeConsumerProtocolSubscription,
  encodeConsumerProtocolAssignment,
  encodeConsumerProtocolSubscription,
} from '../../src/kafka/consumer-protocol.js';

describe('ConsumerProtocolSubscription', () => {
  it('round-trips topics, null userData, and no owned partitions at version 0', () => {
    const encoded = encodeConsumerProtocolSubscription({
      version: 0,
      topics: ['a', 'b'],
      userData: null,
      ownedPartitions: [],
    });
    const decoded = decodeConsumerProtocolSubscription(encoded);
    expect(decoded.version).toBe(0);
    expect(decoded.topics).toEqual(['a', 'b']);
    expect(decoded.userData).toBeNull();
    expect(decoded.ownedPartitions).toEqual([]);
  });

  it('round-trips ownedPartitions and non-null userData at version 1', () => {
    const encoded = encodeConsumerProtocolSubscription({
      version: 1,
      topics: ['events'],
      userData: Buffer.from('hello'),
      ownedPartitions: [{ topic: 'events', partitions: [0, 2, 5] }],
    });
    const decoded = decodeConsumerProtocolSubscription(encoded);
    expect(decoded.version).toBe(1);
    expect(decoded.topics).toEqual(['events']);
    expect(decoded.userData).toEqual(Buffer.from('hello'));
    expect(decoded.ownedPartitions).toEqual([{ topic: 'events', partitions: [0, 2, 5] }]);
  });

  it('round-trips an empty topic list', () => {
    const decoded = decodeConsumerProtocolSubscription(
      encodeConsumerProtocolSubscription({ version: 1, topics: [], userData: null, ownedPartitions: [] }),
    );
    expect(decoded.topics).toEqual([]);
  });

  it('round-trips multiple topics in ownedPartitions', () => {
    const decoded = decodeConsumerProtocolSubscription(
      encodeConsumerProtocolSubscription({
        version: 1,
        topics: ['a', 'b'],
        userData: null,
        ownedPartitions: [
          { topic: 'a', partitions: [0, 1] },
          { topic: 'b', partitions: [3] },
        ],
      }),
    );
    expect(decoded.ownedPartitions).toEqual([
      { topic: 'a', partitions: [0, 1] },
      { topic: 'b', partitions: [3] },
    ]);
  });
});

describe('ConsumerProtocolAssignment', () => {
  it('round-trips an assignment with partitions and null userData', () => {
    const encoded = encodeConsumerProtocolAssignment({
      version: 1,
      partitions: [
        { topic: 'events', partitions: [0, 1] },
        { topic: 'logs', partitions: [2] },
      ],
      userData: null,
    });
    const decoded = decodeConsumerProtocolAssignment(encoded);
    expect(decoded.version).toBe(1);
    expect(decoded.partitions).toEqual([
      { topic: 'events', partitions: [0, 1] },
      { topic: 'logs', partitions: [2] },
    ]);
    expect(decoded.userData).toBeNull();
  });

  it('round-trips an empty assignment (a member that got nothing)', () => {
    const decoded = decodeConsumerProtocolAssignment(
      encodeConsumerProtocolAssignment({ version: 1, partitions: [], userData: null }),
    );
    expect(decoded.partitions).toEqual([]);
  });
});
