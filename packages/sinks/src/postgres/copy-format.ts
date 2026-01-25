import { quoteCsvField } from '@ferrule/codecs';

/**
 * Encoding (and, for `text` format, decoding — used by property tests to verify the escaping
 * round-trips) for PostgreSQL's `COPY ... FROM STDIN` row formats. See the PostgreSQL
 * documentation, "COPY", §"File Formats".
 */

export interface CopyTextOptions {
  /** Column delimiter. Default `"\t"`, matching `COPY`'s own default. */
  delimiter?: string;
}

/** Escapes one field for `text` format: backslash, the delimiter, newline, and carriage return
 * are backslash-escaped; everything else passes through unchanged. `null` becomes the literal
 * two-character marker `\N`. */
export function escapeCopyTextField(value: string | null, options: CopyTextOptions = {}): string {
  if (value === null) return '\\N';
  const delimiter = options.delimiter ?? '\t';
  let out = '';
  for (const ch of value) {
    if (ch === '\\') out += '\\\\';
    else if (ch === '\n') out += '\\n';
    else if (ch === '\r') out += '\\r';
    else if (ch === delimiter) out += `\\${delimiter}`;
    else out += ch;
  }
  return out;
}

/** Encodes one row as a `text`-format `COPY` line, including its trailing `\n`. */
export function encodeCopyTextRow(
  values: readonly (string | null)[],
  options: CopyTextOptions = {},
): string {
  const delimiter = options.delimiter ?? '\t';
  return `${values.map((v) => escapeCopyTextField(v, options)).join(delimiter)}\n`;
}

/** Splits one `text`-format `COPY` line (without its trailing newline) into raw, still-escaped
 * field substrings, respecting backslash-escaped delimiter occurrences. */
function splitCopyTextRow(line: string, delimiter: string): string[] {
  const rawFields: string[] = [];
  let current = '';
  for (let i = 0; i < line.length; i++) {
    const ch = line[i]!;
    if (ch === '\\' && i + 1 < line.length) {
      current += ch + line[i + 1];
      i++;
      continue;
    }
    if (ch === delimiter) {
      rawFields.push(current);
      current = '';
      continue;
    }
    current += ch;
  }
  rawFields.push(current);
  return rawFields;
}

function unescapeCopyTextField(raw: string): string {
  let out = '';
  for (let i = 0; i < raw.length; i++) {
    const ch = raw[i]!;
    if (ch === '\\' && i + 1 < raw.length) {
      const next = raw[i + 1]!;
      i++;
      if (next === 'n') out += '\n';
      else if (next === 'r') out += '\r';
      else if (next === 't') out += '\t';
      else if (next === '\\') out += '\\';
      else out += next; // an escaped delimiter (or any other char) unescapes to itself
      continue;
    }
    out += ch;
  }
  return out;
}

/**
 * Decodes one `text`-format `COPY` line back into field values (`null` for the `\N` marker). The
 * inverse of {@link encodeCopyTextRow} (its trailing `\n` should already be stripped by the
 * caller's line framing). The NULL check is performed on the *raw*, still-escaped field so that
 * actual data equal to the two characters `\N` (encoded on the wire as `\\N`) is never confused
 * with the NULL marker.
 */
export function decodeCopyTextRow(line: string, options: CopyTextOptions = {}): (string | null)[] {
  const delimiter = options.delimiter ?? '\t';
  return splitCopyTextRow(line, delimiter).map((raw) =>
    raw === '\\N' ? null : unescapeCopyTextField(raw),
  );
}

export interface CopyCsvOptions {
  delimiter?: string;
  quote?: string;
  /** String written for `null`. Default `""` (empty, unquoted) — matches `COPY`'s CSV default.
   * A real empty string is always force-quoted (`""`) so it is never confused with `null`. */
  nullString?: string;
}

/** Encodes one row as a `csv`-format `COPY` line, including its trailing `\n`. */
export function encodeCopyCsvRow(
  values: readonly (string | null)[],
  options: CopyCsvOptions = {},
): string {
  const delimiter = options.delimiter ?? ',';
  const quote = options.quote ?? '"';
  const nullString = options.nullString ?? '';
  const fields = values.map((v) => {
    if (v === null) return nullString;
    if (v === '') return `${quote}${quote}`;
    return quoteCsvField(v, delimiter, quote);
  });
  return `${fields.join(delimiter)}\n`;
}
