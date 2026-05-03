import { Agent as HttpsAgent, type RequestOptions as HttpsRequestOptions } from 'node:https';
import { connect as netConnect } from 'node:net';
import { connect as tlsConnect } from 'node:tls';
import type { Duplex } from 'node:stream';
import type { ProxyOptions } from './schema.js';
import type { ResolvedTls } from './tls.js';

export interface ResolvedProxy {
  readonly protocol: 'http' | 'https';
  readonly hostname: string;
  readonly port: number;
  readonly auth: { username: string; password: string } | undefined;
}

/**
 * Resolves the proxy (if any) that should be used to reach `target`, following the conventional
 * `HTTP_PROXY`/`HTTPS_PROXY`/`NO_PROXY` environment variables (and their lowercase forms) unless
 * an explicit `options.url` overrides them, or `options.use_env` is `false`.
 */
export function resolveProxy(
  target: URL,
  options: ProxyOptions | undefined,
  env: NodeJS.ProcessEnv = process.env,
): ResolvedProxy | undefined {
  if (options?.url !== undefined) return toResolvedProxy(new URL(options.url));
  if (options?.use_env === false) return undefined;
  const noProxy = env['NO_PROXY'] ?? env['no_proxy'] ?? '';
  if (matchesNoProxy(target.hostname, noProxy)) return undefined;
  const raw =
    target.protocol === 'https:'
      ? (env['HTTPS_PROXY'] ?? env['https_proxy'])
      : (env['HTTP_PROXY'] ?? env['http_proxy']);
  if (raw === undefined || raw === '') return undefined;
  return toResolvedProxy(new URL(raw));
}

function toResolvedProxy(proxyUrl: URL): ResolvedProxy {
  const protocol = proxyUrl.protocol === 'https:' ? 'https' : 'http';
  const port = proxyUrl.port !== '' ? Number(proxyUrl.port) : protocol === 'https' ? 443 : 80;
  const auth =
    proxyUrl.username !== ''
      ? {
          username: decodeURIComponent(proxyUrl.username),
          password: decodeURIComponent(proxyUrl.password),
        }
      : undefined;
  return { protocol, hostname: proxyUrl.hostname, port, auth };
}

function matchesNoProxy(hostname: string, noProxy: string): boolean {
  const entries = noProxy
    .split(',')
    .map((s) => s.trim())
    .filter((s) => s.length > 0);
  for (const entry of entries) {
    if (entry === '*') return true;
    const bare = entry.startsWith('.') ? entry.slice(1) : entry;
    if (hostname === bare || hostname.endsWith(`.${bare}`)) return true;
  }
  return false;
}

/**
 * An `https.Agent` that reaches its target through an HTTP(S) forward proxy by issuing a
 * `CONNECT` tunnel and then negotiating TLS over the resulting raw socket. Used only for `https`
 * targets; `http` targets behind a proxy need no tunnel (the plain request is simply addressed to
 * the proxy instead of the origin, see {@link proxiedRequestTarget}).
 */
export class TunnelingHttpsAgent extends HttpsAgent {
  constructor(
    private readonly proxy: ResolvedProxy,
    private readonly tls: ResolvedTls,
    agentOptions?: ConstructorParameters<typeof HttpsAgent>[0],
  ) {
    super(agentOptions);
  }

  override createConnection(
    options: HttpsRequestOptions,
    callback?: (err: Error | null, stream: Duplex) => void,
  ): Duplex | null | undefined {
    const targetHost = String(options.host ?? options.hostname ?? '');
    const targetPort = options.port !== undefined ? Number(options.port) : 443;
    const proxySocket = netConnect({ host: this.proxy.hostname, port: this.proxy.port });
    let buffered = '';
    let settled = false;

    const fail = (err: Error): void => {
      if (settled) return;
      settled = true;
      proxySocket.destroy();
      callback?.(err, undefined as unknown as Duplex);
    };

    proxySocket.once('error', fail);
    proxySocket.once('connect', () => {
      const authHeader =
        this.proxy.auth !== undefined
          ? `Proxy-Authorization: Basic ${Buffer.from(
              `${this.proxy.auth.username}:${this.proxy.auth.password}`,
            ).toString('base64')}\r\n`
          : '';
      proxySocket.write(
        `CONNECT ${targetHost}:${targetPort} HTTP/1.1\r\n` +
          `Host: ${targetHost}:${targetPort}\r\n${authHeader}\r\n`,
      );
    });
    const onData = (chunk: Buffer): void => {
      buffered += chunk.toString('latin1');
      const end = buffered.indexOf('\r\n\r\n');
      if (end === -1) return;
      proxySocket.removeListener('data', onData);
      const statusLine = buffered.slice(0, buffered.indexOf('\r\n'));
      const match = /^HTTP\/1\.[01] (\d{3})/.exec(statusLine);
      if (match === null || match[1]!.charAt(0) !== '2') {
        fail(new Error(`proxy CONNECT to ${targetHost}:${targetPort} failed: ${statusLine}`));
        return;
      }
      if (settled) return;
      settled = true;
      proxySocket.removeListener('error', fail);
      const tlsSocket = tlsConnect({
        socket: proxySocket,
        servername: this.tls.servername ?? targetHost,
        ca: this.tls.ca,
        cert: this.tls.cert,
        key: this.tls.key,
        rejectUnauthorized: this.tls.rejectUnauthorized,
      });
      tlsSocket.once('error', (err: Error) => callback?.(err, undefined as unknown as Duplex));
      tlsSocket.once('secureConnect', () => callback?.(null, tlsSocket));
    };
    proxySocket.on('data', onData);
    return undefined;
  }
}

/** For a plain `http` target reached through a proxy, the request is simply addressed to the
 * proxy's own host/port with the target's full URL as the request path and the target host kept
 * in the `Host` header — no tunnel is needed. */
export function proxiedRequestTarget(proxy: ResolvedProxy): { hostname: string; port: number } {
  return { hostname: proxy.hostname, port: proxy.port };
}
