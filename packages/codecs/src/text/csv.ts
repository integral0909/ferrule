import {
  createMetadata,
  LimitExceededError,
  LogEvent,
  type Value,
  type ValueMap,
} from '@ferrule/core';
import { CodecSyntaxError } from '../errors.js';
import { stringifyValue } from '../value_text.js';

const CODEC = 'csv';

export interface CsvOptions {
  /** Field delimiter. Default `,`. */
  delimiter?: string;
  /** Quote character. Default `"`. */
  quote?: string;
  /** Maximum characters in one field. Default 1 MiB. */
  maxFieldLength?: number;
  /** Maximum fields in one row. Default 4096. */
  maxFields?: number;
  /** Maximum rows accepted from one input. Default unlimited. */
  maxRows?: number;
}

const DEFAULT_MAX_FIELD_LENGTH = 1024 * 1024;
const DEFAULT_MAX_FIELDS = 4096;

function fail(message: string): never {
  throw new CodecSyntaxError(CODEC, 'E_CSV_SYNTAX', message);
}

/**
 * A streaming RFC 4180 CSV row parser: quoted fields may contain the delimiter, literal newlines,
 * and an escaped quote (`""`); rows are terminated by `\r\n`, bare `\n`, or bare `\r`. Safe to feed
 * arbitrarily small chunks — quotes and terminators split across chunk boundaries are handled by
 * holding back at most one pending character between calls.
 */
export class CsvParser {
  private readonly delimiter: string;
  private readonly quote: string;
  private readonly maxFieldLength: number;
  private readonly maxFields: number;
  private readonly maxRows: number;

  private field = '';
  private row: string[] = [];
  private inQuotes = false;
  private rowCount = 0;
  private carry = '';
  private sawAnyContent = false;

  constructor(options: CsvOptions = {}) {
    this.delimiter = options.delimiter ?? ',';
    this.quote = options.quote ?? '"';
    if (this.delimiter.length !== 1) fail('delimiter must be exactly one character');
    if (this.quote.length !== 1 && this.quote.length !== 0) {
      fail('quote must be empty or exactly one character');
    }
    this.maxFieldLength = options.maxFieldLength ?? DEFAULT_MAX_FIELD_LENGTH;
    this.maxFields = options.maxFields ?? DEFAULT_MAX_FIELDS;
    this.maxRows = options.maxRows ?? Infinity;
  }

  /** Feeds a chunk of text, returning zero or more complete rows. */
  push(chunk: string): string[][] {
    if (chunk.length === 0) return [];
    this.sawAnyContent = true;
    const text = this.carry + chunk;
    this.carry = '';
    return this.consume(text, false);
  }

  /** Flushes any buffered field/row at end of input. */
  finish(): string[][] {
    const text = this.carry;
    this.carry = '';
    const rows = this.sawAnyContent ? this.consume(text, true) : [];
    if (this.field !== '' || this.row.length > 0) {
      this.endField();
      rows.push(...this.endRow());
    }
    return rows;
  }

  private consume(text: string, atEnd: boolean): string[][] {
    const rows: string[][] = [];
    const n = text.length;
    let i = 0;
    while (i < n) {
      const c = text[i]!;
      if (this.inQuotes) {
        if (c === this.quote) {
          if (i + 1 < n) {
            if (text[i + 1] === this.quote) {
              this.appendField(this.quote);
              i += 2;
              continue;
            }
            this.inQuotes = false;
            i++;
            continue;
          }
          if (!atEnd) {
            this.carry = text.slice(i);
            return rows;
          }
          this.inQuotes = false;
          i++;
          continue;
        }
        this.appendField(c);
        i++;
        continue;
      }

      if (c === this.quote && this.field === '' && !this.fieldHadQuoteOpen) {
        this.inQuotes = true;
        this.fieldHadQuoteOpen = true;
        i++;
        continue;
      }
      if (c === this.delimiter) {
        this.endField();
        i++;
        continue;
      }
      if (c === '\r') {
        if (i + 1 < n) {
          this.endField();
          rows.push(...this.endRow());
          i += text[i + 1] === '\n' ? 2 : 1;
          continue;
        }
        if (!atEnd) {
          this.carry = text.slice(i);
          return rows;
        }
        this.endField();
        rows.push(...this.endRow());
        i++;
        continue;
      }
      if (c === '\n') {
        this.endField();
        rows.push(...this.endRow());
        i++;
        continue;
      }
      this.appendField(c);
      i++;
    }
    return rows;
  }

  private fieldHadQuoteOpen = false;

  private appendField(c: string): void {
    if (this.field.length >= this.maxFieldLength) {
      throw new LimitExceededError('csv.field.length', this.maxFieldLength);
    }
    this.field += c;
  }

  private endField(): void {
    if (this.row.length >= this.maxFields) {
      throw new LimitExceededError(
        'csv.fields',
        this.maxFields,
        `row has more than ${this.maxFields} fields`,
      );
    }
    this.row.push(this.field);
    this.field = '';
    this.fieldHadQuoteOpen = false;
  }

  private endRow(): string[][] {
    const row = this.row;
    this.row = [];
    this.rowCount++;
    if (this.rowCount > this.maxRows) throw new LimitExceededError('csv.rows', this.maxRows);
    return [row];
  }
}

/** Parses a complete CSV document (all rows) in one call. */
export function parseCsv(text: string, options: CsvOptions = {}): string[][] {
  const parser = new CsvParser(options);
  return [...parser.push(text), ...parser.finish()];
}

/** Escapes and quotes `field` only if needed (contains the delimiter, quote, or a newline). */
export function quoteCsvField(field: string, delimiter: string, quote: string): string {
  if (quote === '') return field;
  if (
    !field.includes(delimiter) &&
    !field.includes(quote) &&
    !field.includes('\n') &&
    !field.includes('\r')
  ) {
    return field;
  }
  return `${quote}${field.split(quote).join(quote + quote)}${quote}`;
}

export type CsvEncodeOptions = Pick<CsvOptions, 'delimiter' | 'quote'>;

/** Encodes rows as CSV text (RFC 4180, `\r\n` row terminators, always including a trailing one). */
export function encodeCsv(
  rows: readonly (readonly string[])[],
  options: CsvEncodeOptions = {},
): string {
  const delimiter = options.delimiter ?? ',';
  const quote = options.quote ?? '"';
  let out = '';
  for (const row of rows) {
    out += row.map((f) => quoteCsvField(f, delimiter, quote)).join(delimiter);
    out += '\r\n';
  }
  return out;
}

export interface CsvLogDecodeOptions extends CsvOptions {
  /** Whether the first row is a header naming each column. Default `true`. */
  header?: boolean;
  /** Column names to use when `header` is `false`. Default `column0`, `column1`, ... */
  columns?: readonly string[];
}

/** Decodes a complete CSV document into one {@link LogEvent} per data row, with each column
 * becoming a top-level string field named by the header (or `columns`/`columnN`). A row with
 * fewer fields than the header leaves the missing columns unset; a row with more fields keeps the
 * extras under `column<N>`. */
export function decodeCsvToLogEvents(text: string, options: CsvLogDecodeOptions = {}): LogEvent[] {
  const rows = parseCsv(text, options);
  if (rows.length === 0) return [];
  const useHeader = options.header ?? true;
  const header = useHeader ? rows[0]! : (options.columns ?? []);
  const dataRows = useHeader ? rows.slice(1) : rows;
  const events: LogEvent[] = [];
  for (const row of dataRows) {
    const fields: ValueMap = new Map();
    for (let i = 0; i < row.length; i++) {
      const name = header[i] ?? `column${i}`;
      fields.set(name, row[i]!);
    }
    events.push(new LogEvent(fields, createMetadata()));
  }
  return events;
}

export interface CsvLogEncodeOptions extends CsvEncodeOptions {
  /** Whether to emit a header row. Default `true`. */
  header?: boolean;
}

/** Encodes `events` as CSV using `columns` (in order) as the field selection and header. */
export function encodeLogEventsAsCsv(
  events: readonly LogEvent[],
  columns: readonly string[],
  options: CsvLogEncodeOptions = {},
): string {
  const rows: string[][] = [];
  if (options.header ?? true) rows.push([...columns]);
  for (const event of events) {
    rows.push(columns.map((c) => stringifyOrEmpty(event.get(c))));
  }
  return encodeCsv(rows, options);
}

function stringifyOrEmpty(value: Value | undefined): string {
  return value === undefined ? '' : stringifyValue(value);
}
