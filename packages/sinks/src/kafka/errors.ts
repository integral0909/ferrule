import { FerruleError } from '@ferrule/core';

/** A subset of Kafka's error code table (see `org.apache.kafka.common.protocol.Errors`) with
 * names for the codes this client's own logic branches on or reports. */
export const KafkaErrorCode = {
  NONE: 0,
  UNKNOWN_SERVER_ERROR: -1,
  OFFSET_OUT_OF_RANGE: 1,
  CORRUPT_MESSAGE: 2,
  UNKNOWN_TOPIC_OR_PARTITION: 3,
  LEADER_NOT_AVAILABLE: 5,
  NOT_LEADER_OR_FOLLOWER: 6,
  REQUEST_TIMED_OUT: 7,
  MESSAGE_TOO_LARGE: 10,
  NETWORK_EXCEPTION: 13,
  INVALID_TOPIC_EXCEPTION: 17,
  RECORD_LIST_TOO_LARGE: 18,
  NOT_ENOUGH_REPLICAS: 19,
  NOT_ENOUGH_REPLICAS_AFTER_APPEND: 20,
  INVALID_REQUIRED_ACKS: 21,
  TOPIC_AUTHORIZATION_FAILED: 29,
  CLUSTER_AUTHORIZATION_FAILED: 31,
  UNSUPPORTED_SASL_MECHANISM: 33,
  ILLEGAL_SASL_STATE: 34,
  OUT_OF_ORDER_SEQUENCE_NUMBER: 45,
  DUPLICATE_SEQUENCE_NUMBER: 46,
  INVALID_PRODUCER_EPOCH: 47,
  KAFKA_STORAGE_ERROR: 56,
  SASL_AUTHENTICATION_FAILED: 58,
  UNKNOWN_PRODUCER_ID: 59,
  PRODUCER_FENCED: 90,
} as const;

/**
 * Error codes worth retrying (after a metadata refresh, for the leader-related ones): transient
 * broker/cluster conditions where the same produce is expected to succeed shortly, matching
 * `Errors.exception().retriable()` for the subset of errors this producer can encounter. Every
 * other code — including unrecognised ones — is treated as permanent, since guessing retryability
 * for an error this client does not specifically know about is unsafe.
 */
const RETRIABLE_CODES: ReadonlySet<number> = new Set([
  KafkaErrorCode.CORRUPT_MESSAGE,
  KafkaErrorCode.UNKNOWN_TOPIC_OR_PARTITION,
  KafkaErrorCode.LEADER_NOT_AVAILABLE,
  KafkaErrorCode.NOT_LEADER_OR_FOLLOWER,
  KafkaErrorCode.REQUEST_TIMED_OUT,
  KafkaErrorCode.NETWORK_EXCEPTION,
  KafkaErrorCode.NOT_ENOUGH_REPLICAS,
  KafkaErrorCode.NOT_ENOUGH_REPLICAS_AFTER_APPEND,
  KafkaErrorCode.KAFKA_STORAGE_ERROR,
  KafkaErrorCode.UNKNOWN_SERVER_ERROR,
]);

/** Error codes that specifically mean "the metadata this client is using is stale" and so should
 * trigger a metadata refresh before the retry, not just a plain resend. */
const STALE_METADATA_CODES: ReadonlySet<number> = new Set([
  KafkaErrorCode.UNKNOWN_TOPIC_OR_PARTITION,
  KafkaErrorCode.LEADER_NOT_AVAILABLE,
  KafkaErrorCode.NOT_LEADER_OR_FOLLOWER,
]);

export function isRetriableErrorCode(code: number): boolean {
  return RETRIABLE_CODES.has(code);
}

export function needsMetadataRefresh(code: number): boolean {
  return STALE_METADATA_CODES.has(code);
}

/** The idempotent producer's broker-side dedup signal: this exact sequence range has already
 * been appended (typically because an earlier attempt's response was lost, e.g. to a connection
 * drop, and the producer retried). Treated as success, not an error. */
export function isDuplicateSequenceErrorCode(code: number): boolean {
  return code === KafkaErrorCode.DUPLICATE_SEQUENCE_NUMBER;
}

/**
 * Error codes where the idempotent producer's (producerId, epoch, sequence) state can no longer
 * be trusted: a sequence gap was detected, the epoch no longer matches what the broker has on
 * file, or another producer instance with the same identity has fenced this one out. Resending
 * the same batch under the same identity is not safe (the broker's dedup window is keyed by
 * producer ID + epoch, and this response means that bookkeeping has diverged), so the only
 * recovery is a fresh producer ID — see `KafkaProducer`'s handling of these codes, which finishes
 * the affected batch's events `errored` rather than risking either a duplicate or reordering.
 */
export function needsProducerIdReset(code: number): boolean {
  return (
    code === KafkaErrorCode.OUT_OF_ORDER_SEQUENCE_NUMBER ||
    code === KafkaErrorCode.INVALID_PRODUCER_EPOCH ||
    code === KafkaErrorCode.PRODUCER_FENCED ||
    code === KafkaErrorCode.UNKNOWN_PRODUCER_ID
  );
}

function errorCodeName(code: number): string {
  for (const [name, value] of Object.entries(KafkaErrorCode)) {
    if (value === code) return name;
  }
  return `UNKNOWN(${code})`;
}

/** A per-partition (or per-request) error reported by a Kafka broker. */
export class KafkaError extends FerruleError {
  readonly errorCode: number;

  constructor(errorCode: number, message?: string) {
    super(
      `E_KAFKA_${errorCodeName(errorCode)}`,
      message ?? `Kafka error: ${errorCodeName(errorCode)} (${errorCode})`,
    );
    this.name = 'KafkaError';
    this.errorCode = errorCode;
  }

  get isRetryable(): boolean {
    return isRetriableErrorCode(this.errorCode);
  }

  get needsMetadataRefresh(): boolean {
    return needsMetadataRefresh(this.errorCode);
  }
}

/** Raised for protocol-level problems (malformed frames, unexpected responses) rather than a
 * broker-reported per-partition error. */
export class KafkaProtocolError extends FerruleError {
  constructor(message: string) {
    super('E_KAFKA_PROTOCOL', message);
    this.name = 'KafkaProtocolError';
  }
}

export class KafkaAuthError extends FerruleError {
  constructor(message: string) {
    super('E_KAFKA_AUTH', message);
    this.name = 'KafkaAuthError';
  }
}
