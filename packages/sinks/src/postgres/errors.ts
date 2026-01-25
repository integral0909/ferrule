import { FerruleError } from '@ferrule/core';
import type { PgReader } from './wire.js';

/** One field of an `ErrorResponse`/`NoticeResponse` message, keyed by its single-byte field type
 * code (PostgreSQL protocol docs, "ErrorResponse (B)"). */
export interface PgNoticeFields {
  severity: string | undefined;
  code: string | undefined; // SQLSTATE, e.g. "23505"
  message: string | undefined;
  detail: string | undefined;
  hint: string | undefined;
  position: string | undefined;
  where: string | undefined;
  schema: string | undefined;
  table: string | undefined;
  column: string | undefined;
  dataType: string | undefined;
  constraint: string | undefined;
  file: string | undefined;
  line: string | undefined;
  routine: string | undefined;
}

const FIELD_CODES: Record<string, keyof PgNoticeFields> = {
  S: 'severity',
  C: 'code',
  M: 'message',
  D: 'detail',
  H: 'hint',
  P: 'position',
  W: 'where',
  s: 'schema',
  t: 'table',
  c: 'column',
  d: 'dataType',
  n: 'constraint',
  F: 'file',
  L: 'line',
  R: 'routine',
};

/** Parses the field list of an `ErrorResponse`/`NoticeResponse` body (a sequence of
 * `<1-byte field type><C-string value>`, terminated by a zero byte). */
export function parseNoticeFields(reader: PgReader): PgNoticeFields {
  const fields: Partial<PgNoticeFields> = {};
  for (;;) {
    const code = reader.int8();
    if (code === 0) break;
    const value = reader.cstring();
    const key = FIELD_CODES[String.fromCharCode(code)];
    if (key !== undefined) fields[key] = value;
  }
  return {
    severity: fields.severity,
    code: fields.code,
    message: fields.message,
    detail: fields.detail,
    hint: fields.hint,
    position: fields.position,
    where: fields.where,
    schema: fields.schema,
    table: fields.table,
    column: fields.column,
    dataType: fields.dataType,
    constraint: fields.constraint,
    file: fields.file,
    line: fields.line,
    routine: fields.routine,
  };
}

export type PgErrorClass = 'connection' | 'serialization' | 'constraint' | 'data' | 'other';

/**
 * Classifies a SQLSTATE code (PostgreSQL error codes appendix) into a coarse bucket that
 * determines retry behaviour:
 *
 * - `connection` (class `08`) and `serialization` (`40001` serialization_failure, `40P01`
 *   deadlock_detected) are transient: retrying the same batch is expected to help.
 * - `constraint` (class `23`, integrity constraint violations) and `data` (class `22`, data
 *   exceptions such as invalid text representation) are permanent for the *offending row(s)*, not
 *   necessarily the whole batch — see the sink's bisection logic — but never retryable as-is.
 * - anything else defaults to `other`, treated as non-retryable since PostgreSQL error codes are
 *   specific enough that guessing retryability for an unrecognised class is unsafe.
 */
export function classifySqlState(sqlState: string | undefined): PgErrorClass {
  if (sqlState === undefined || sqlState.length < 2) return 'other';
  const klass = sqlState.slice(0, 2);
  if (klass === '08') return 'connection';
  if (sqlState === '40001' || sqlState === '40P01') return 'serialization';
  if (klass === '23') return 'constraint';
  if (klass === '22') return 'data';
  return 'other';
}

export function isRetryableSqlState(sqlState: string | undefined): boolean {
  const klass = classifySqlState(sqlState);
  return klass === 'connection' || klass === 'serialization';
}

/** An error surfaced by the PostgreSQL server, carrying its full SQLSTATE and notice fields. */
export class PostgresError extends FerruleError {
  readonly sqlState: string | undefined;
  readonly fields: PgNoticeFields;

  constructor(fields: PgNoticeFields) {
    super(`E_POSTGRES_${fields.code ?? 'UNKNOWN'}`, fields.message ?? 'PostgreSQL error');
    this.name = 'PostgresError';
    this.sqlState = fields.code;
    this.fields = fields;
  }

  get errorClass(): PgErrorClass {
    return classifySqlState(this.sqlState);
  }

  get isRetryable(): boolean {
    return isRetryableSqlState(this.sqlState);
  }
}

/** Raised for protocol-level problems (unexpected message sequencing, malformed frames) rather
 * than a server-reported SQL error. Always treated as a bug or an unrecoverable connection state. */
export class PostgresProtocolError extends FerruleError {
  constructor(message: string) {
    super('E_POSTGRES_PROTOCOL', message);
    this.name = 'PostgresProtocolError';
  }
}

/** Raised when authentication fails or a required auth mechanism is unsupported. */
export class PostgresAuthError extends FerruleError {
  constructor(message: string) {
    super('E_POSTGRES_AUTH', message);
    this.name = 'PostgresAuthError';
  }
}
