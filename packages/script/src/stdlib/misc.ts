import { createMetadata, LogEvent, type ValueMap } from '@ferrule/core';
import { impl, type ImplementationRegistry } from '../registry/implementation.js';
import { param, type FunctionRegistry } from '../registry/signature.js';
import { Failure } from '../runtime/failure.js';
import { scriptKindOf } from '../runtime/kinds.js';
import { checkEmittedEvents } from '../runtime/limits.js';
import { assertNoRegex } from '../runtime/regex.js';
import { abortSignal } from '../runtime/signal.js';
import { boolType, nullType, stringType } from '../types/types.js';
import { fn } from './helpers.js';

/**
 * Assertions, debug logging, and `emit` (already declared in `registry/builtins.ts`; this module
 * adds only its implementation). These are the standard library's only side-effecting/impure
 * functions besides `del`/`now`.
 */
export function registerMisc(registry: FunctionRegistry, impls?: ImplementationRegistry): void {
  registry.register(
    fn(
      'assert',
      [
        param('condition', boolType, { doc: 'aborts the event unless this is true' }),
        param('message', stringType, {
          optional: true,
          namedOnly: true,
          defaultDoc: '"assertion failed"',
        }),
      ],
      nullType,
      'never',
      false,
      'Aborts the event (with `message`, if given) unless `condition` is true.',
      ['assert(.status_code < 600, message: "invalid status code")'],
    ),
  );
  impls?.register(
    impl('assert', (args, _ctx, span) => {
      if (args.positional[0] !== true) {
        const message = args.named.get('message');
        throw abortSignal(typeof message === 'string' ? message : 'assertion failed', span);
      }
      return null;
    }),
  );

  registry.register(
    fn(
      'log',
      [
        param('message', stringType, { doc: 'text to log' }),
        param('level', stringType, { optional: true, namedOnly: true, defaultDoc: '"info"' }),
      ],
      nullType,
      'never',
      false,
      "Emits a debug log line through the host's log sink, rate-limited per compiled program (see `CompileOptions.logsPerSecond`).",
      ['log("saw a {{ .status }} response", level: "debug")'],
    ),
  );
  impls?.register(
    impl('log', (args, ctx, span) => {
      const message = args.positional[0] ?? null;
      if (typeof message !== 'string') {
        return new Failure(`log requires a string message, found ${scriptKindOf(message)}`);
      }
      if (ctx.logLimiter.allow()) {
        const level = args.named.get('level');
        ctx.onLog({ level: typeof level === 'string' ? level : 'info', message, span });
      }
      return null;
    }),
  );

  impls?.register(
    impl('emit', (args, ctx, span) => {
      const value = assertNoRegex(args.positional[0] ?? null, span);
      const fields: ValueMap = value instanceof Map ? value : new Map([['value', value]]);
      ctx.emitted.push(new LogEvent(fields, createMetadata({ receivedAt: ctx.clock() })));
      checkEmittedEvents(ctx.emitted.length, ctx.limits, span);
      return null;
    }),
  );
}
