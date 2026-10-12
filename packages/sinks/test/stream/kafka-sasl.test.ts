import { afterEach, describe, expect, it } from 'vitest';
import { LogEvent } from '@ferrule/core';
import { KafkaAuthError } from '@ferrule/codecs';
import { KafkaProducer } from '../../src/kafka/producer.js';
import { FakeKafkaBroker } from './support/fake-kafka-broker.js';

let broker: FakeKafkaBroker | undefined;
let producer: KafkaProducer | undefined;

afterEach(async () => {
  if (producer !== undefined) await producer.close();
  if (broker !== undefined) await broker.close();
  producer = undefined;
  broker = undefined;
});

describe('Kafka SASL/PLAIN', () => {
  it('authenticates with correct credentials', async () => {
    broker = new FakeKafkaBroker({
      partitionCounts: { t: 1 },
      sasl: { mechanism: 'PLAIN', username: 'alice', password: 'secret' },
    });
    const port = await broker.listen();
    producer = new KafkaProducer({
      bootstrapBrokers: [{ host: '127.0.0.1', port }],
      sasl: { mechanism: 'PLAIN', username: 'alice', password: 'secret' },
    });
    await expect(producer.healthcheck()).resolves.toBeUndefined();
    const event = LogEvent.fromMessage('x');
    await producer.send([
      { topic: 't', key: null, value: Buffer.from('v'), headers: [], timestamp: 0n, event },
    ]);
    expect(broker.receivedBatches).toHaveLength(1);
  });

  it('rejects the wrong password', async () => {
    broker = new FakeKafkaBroker({
      partitionCounts: { t: 1 },
      sasl: { mechanism: 'PLAIN', username: 'alice', password: 'secret' },
    });
    const port = await broker.listen();
    producer = new KafkaProducer({
      bootstrapBrokers: [{ host: '127.0.0.1', port }],
      sasl: { mechanism: 'PLAIN', username: 'alice', password: 'wrong' },
    });
    await expect(producer.healthcheck()).rejects.toThrow(KafkaAuthError);
  });
});

describe('Kafka SASL/SCRAM-SHA-256', () => {
  it('authenticates with correct credentials', async () => {
    broker = new FakeKafkaBroker({
      partitionCounts: { t: 1 },
      sasl: { mechanism: 'SCRAM-SHA-256', username: 'bob', password: 'pencil' },
    });
    const port = await broker.listen();
    producer = new KafkaProducer({
      bootstrapBrokers: [{ host: '127.0.0.1', port }],
      sasl: { mechanism: 'SCRAM-SHA-256', username: 'bob', password: 'pencil' },
    });
    await expect(producer.healthcheck()).resolves.toBeUndefined();
  });

  it('rejects the wrong password', async () => {
    broker = new FakeKafkaBroker({
      partitionCounts: { t: 1 },
      sasl: { mechanism: 'SCRAM-SHA-256', username: 'bob', password: 'pencil' },
    });
    const port = await broker.listen();
    producer = new KafkaProducer({
      bootstrapBrokers: [{ host: '127.0.0.1', port }],
      sasl: { mechanism: 'SCRAM-SHA-256', username: 'bob', password: 'not-pencil' },
    });
    await expect(producer.healthcheck()).rejects.toThrow(KafkaAuthError);
  });
});

describe('Kafka SASL mechanism mismatch', () => {
  it('rejects a client mechanism the broker does not offer', async () => {
    broker = new FakeKafkaBroker({
      partitionCounts: { t: 1 },
      sasl: { mechanism: 'PLAIN', username: 'alice', password: 'secret' },
    });
    const port = await broker.listen();
    producer = new KafkaProducer({
      bootstrapBrokers: [{ host: '127.0.0.1', port }],
      sasl: { mechanism: 'SCRAM-SHA-256', username: 'alice', password: 'secret' },
    });
    await expect(producer.healthcheck()).rejects.toThrow(KafkaAuthError);
  });
});
