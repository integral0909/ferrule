import { readFileSync } from 'node:fs';
import { FerruleError } from '@ferrule/core';
import type { Logger } from '@ferrule/runtime';
import type { TlsOptions } from './schema.js';

/** The subset of Node's TLS connection options this package needs to build from {@link TlsOptions}. */
export interface ResolvedTls {
  readonly ca?: Buffer;
  readonly cert?: Buffer;
  readonly key?: Buffer;
  readonly rejectUnauthorized: boolean;
}

/**
 * Reads certificate/key files declared in `options` and turns them into the options Node's
 * `https`/`tls` modules expect. Disabling verification is logged loudly (once, at build time)
 * since it defeats TLS entirely.
 */
export function resolveTls(options: TlsOptions | undefined, logger: Logger): ResolvedTls {
  const verify = options?.verify ?? true;
  if (!verify) {
    logger.warn(
      'TLS certificate verification is DISABLED for this sink; connections are not authenticated ' +
        'and are vulnerable to interception. This should never be used in production.',
    );
  }
  const resolved: ResolvedTls = { rejectUnauthorized: verify };
  return {
    ...resolved,
    ...(options?.caFile !== undefined ? { ca: readCertFile(options.caFile, 'CA') } : {}),
    ...(options?.certFile !== undefined
      ? { cert: readCertFile(options.certFile, 'client certificate') }
      : {}),
    ...(options?.keyFile !== undefined
      ? { key: readCertFile(options.keyFile, 'client private key') }
      : {}),
  };
}

function readCertFile(path: string, kind: string): Buffer {
  try {
    return readFileSync(path);
  } catch (cause) {
    throw new FerruleError('E_HTTP_TLS_FILE', `cannot read ${kind} file ${JSON.stringify(path)}`, {
      cause,
    });
  }
}
