import { encodeJson, Timestamp, toHex, type Value } from '@ferrule/core';

/**
 * Renders a {@link Value} as plain text: scalars render plainly (numbers and booleans via their
 * natural string form), bytes as lowercase hex, timestamps as RFC 3339, and arrays/objects as
 * compact JSON. Used wherever a structured value needs to become a flat string: metric tags,
 * syslog structured-data parameter values, and internal grouping keys.
 */
export function stringifyValue(value: Value): string {
  switch (typeof value) {
    case 'string':
      return value;
    case 'boolean':
      return value ? 'true' : 'false';
    case 'bigint':
      return value.toString();
    case 'number':
      return String(value);
    case 'object':
      if (value === null) return '';
      if (value instanceof Uint8Array) return toHex(value);
      if (value instanceof Timestamp) return value.toISOString();
      return encodeJson(value);
    default:
      return '';
  }
}
