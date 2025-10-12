import type { LogEvent } from '@ferrule/core';
import { formatPath, fromPlain, type Event } from '@ferrule/core';
import { s, type Infer } from '@ferrule/schema';
import {
  defineTransform,
  DEFAULT_PORT,
  ERROR_PORT,
  type OutputPort,
  type TransformOutput,
} from '@ferrule/runtime';
import { coerceValue } from './util/coerce.js';

/**
 * `remap_fields` — declarative field operations on log events: rename, copy, move, delete, set a
 * constant, or coerce a type. No scripting: every operation is a fixed, typed shape, applied in
 * the order given. This is the operator to reach for when a `script` transform would be
 * overkill (a handful of renames and type fixes on ingest).
 */

const coerceTarget = s.enum(['int', 'float', 'string', 'bool', 'timestamp'] as const);
const timestampFormat = s.enum(['rfc3339', 'unix_seconds', 'unix_millis', 'unix_nanos'] as const);

const operationSchema = s.tagged('op', {
  rename: s.object({
    from: s.fieldPath().describe('field to rename'),
    to: s.fieldPath().describe('new field path'),
  }),
  copy: s.object({
    from: s.fieldPath().describe('field to read'),
    to: s.fieldPath().describe('field to write the copy to'),
  }),
  move: s.object({
    from: s.fieldPath().describe('field to move'),
    to: s.fieldPath().describe('destination field path'),
  }),
  delete: s.object({
    field: s.fieldPath().describe('field to remove'),
  }),
  set: s.object({
    field: s.fieldPath().describe('field to write'),
    value: s.unknown().describe('constant value (any JSON-compatible type)'),
  }),
  coerce: s.object({
    field: s.fieldPath().describe('field to convert'),
    to: coerceTarget.describe('target type'),
    format: timestampFormat
      .optional()
      .describe('for `to: timestamp`, how to interpret the source value; default rfc3339'),
  }),
});

export type RemapOperation = Infer<typeof operationSchema>;

export const remapFieldsOptions = s.object({
  operations: s
    .array(operationSchema, { minItems: 1 })
    .describe('field operations, applied in order'),
  on_error: s
    .enum(['drop', 'route', 'keep'] as const)
    .default('keep')
    .describe(
      'what to do when an operation fails (a missing source field for rename/copy/move, or a ' +
        'coercion that cannot be parsed): drop the event, route it to the errors port, or keep ' +
        'going with the remaining operations',
    ),
});

export type RemapFieldsOptions = Infer<typeof remapFieldsOptions>;

function applyOperation(event: LogEvent, op: RemapOperation): string | undefined {
  switch (op.op) {
    case 'rename':
    case 'move': {
      if (!event.has(op.from)) return `field ${formatPath(op.from)} does not exist`;
      const value = event.remove(op.from)!;
      event.set(op.to, value);
      return undefined;
    }
    case 'copy': {
      const value = event.get(op.from);
      if (value === undefined) return `field ${formatPath(op.from)} does not exist`;
      event.set(op.to, value);
      return undefined;
    }
    case 'delete':
      event.remove(op.field);
      return undefined;
    case 'set':
      event.set(op.field, fromPlain(op.value));
      return undefined;
    case 'coerce': {
      const current = event.get(op.field);
      if (current === undefined) return `field ${formatPath(op.field)} does not exist`;
      const converted = coerceValue(current, op.to, op.format);
      if (converted === undefined) {
        return `field ${formatPath(op.field)} could not be coerced to ${op.to}`;
      }
      event.set(op.field, converted);
      return undefined;
    }
  }
}

export const remapFieldsTransform = defineTransform<RemapFieldsOptions>({
  kind: 'transform',
  type: 'remap_fields',
  description: 'Renames, copies, moves, deletes, sets, or coerces log fields declaratively.',
  options: remapFieldsOptions,
  accepts: ['log'],
  outputs: (options): readonly OutputPort[] =>
    options.on_error === 'route'
      ? [{ name: ERROR_PORT, description: 'events for which an operation failed' }]
      : [],
  examples: [
    {
      title: 'Normalise a status field and rename a legacy field',
      config: {
        operations: [
          { op: 'rename', from: 'lvl', to: 'level' },
          { op: 'coerce', field: 'status', to: 'int' },
          { op: 'set', field: 'source', value: 'edge' },
          { op: 'delete', field: 'debug' },
        ],
        on_error: 'keep',
      },
    },
  ],
  build: (options) => {
    return {
      process(events: Event[], out: TransformOutput) {
        for (const event of events) {
          const log = event as LogEvent;
          let errored = false;
          for (const op of options.operations) {
            const error = applyOperation(log, op);
            if (error === undefined) continue;
            if (options.on_error === 'keep') continue;
            errored = true;
            if (options.on_error === 'drop') {
              log.metadata.finalizers.finish('rejected');
            } else {
              out.push(log, ERROR_PORT);
            }
            break;
          }
          if (!errored) out.push(log, DEFAULT_PORT);
        }
      },
    };
  },
});
