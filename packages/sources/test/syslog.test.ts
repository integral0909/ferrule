import { createSocket as createDgramSocket, type Socket as DgramSocket } from 'node:dgram';
import { connect as netConnect, type Socket as NetSocket } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { connect as tlsConnect, type TLSSocket } from 'node:tls';
import { afterEach, describe, expect, it } from 'vitest';
import { isLogEvent } from '@ferrule/core';
import type { BuildContext } from '@ferrule/runtime';
import { createCapturingLogger } from '@ferrule/runtime';
import { syslogSource, type SyslogOptions, type SyslogSourceHandle } from '../src/syslog.js';
import { createControllableSourceContext, waitUntil } from './support/context.js';
import { generateSelfSignedCert } from './support/self-signed-cert.js';

function buildCtx(id = 'src'): BuildContext {
  const { logger } = createCapturingLogger();
  return { id, logger, dataDir: undefined, inputs: [] };
}

// A well-formed RFC 5424 line: PRI 34 (facility 4, severity 2), version 1, a real timestamp,
// hostname/app-name/proc-id/msg-id, no structured data, message "Hello world".
const RFC5424_MSG =
  '<34>1 2003-10-11T22:14:15.003Z mymachine.example.com su 1234 ID47 - Hello world';

// A well-formed RFC 3164 ("BSD syslog") line: PRI 34, same facility/severity, host "mymachine",
// tag "su", no proc-id, message "'su root' failed for lonvick on /dev/pts/8".
const RFC3164_MSG = "<34>Oct 11 22:14:15 mymachine su: 'su root' failed for lonvick on /dev/pts/8";

// Matches the RFC 5424 detector (starts with "1 " followed by a digit, per `detectSyslogFormat`)
// but has an otherwise-invalid TIMESTAMP, so it is *detected* as 5424 and then fails deeper
// parsing — unlike genuinely unrecognisable text, which `decodeSyslogAuto` happily wraps as a
// bare message instead of failing.
const MALFORMED_5424_SHAPED = '<34>1 9-bogus host app 123 ID1 - test message';

type RawOptions = Record<string, unknown>;

async function start(rawOptions: RawOptions, acknowledgements = true) {
  const parsed: SyslogOptions = syslogSource.options.parse(rawOptions);
  const handle = (await syslogSource.build(parsed, buildCtx())) as SyslogSourceHandle;
  const harness = createControllableSourceContext({ acknowledgements });
  const runPromise = handle.run(harness.ctx);
  if (rawOptions['tcp'] !== undefined) await waitUntil(() => handle.tcpAddress() !== undefined);
  if (rawOptions['udp'] !== undefined) await waitUntil(() => handle.udpAddress() !== undefined);
  return {
    handle,
    harness,
    runPromise,
    async stop(): Promise<void> {
      harness.releaseSends();
      harness.abort();
      await runPromise;
    },
  };
}

const runningServers: { stop(): Promise<void> }[] = [];
afterEach(async () => {
  await Promise.all(runningServers.splice(0).map((s) => s.stop()));
});

async function startTracked(rawOptions: RawOptions, acknowledgements = true) {
  const started = await start(rawOptions, acknowledgements);
  runningServers.push(started);
  return started;
}

// ---------------------------------------------------------------------------------------------
// TCP client helpers
// ---------------------------------------------------------------------------------------------

function tcpConnect(port: number, host = '127.0.0.1'): Promise<NetSocket> {
  return new Promise((resolve, reject) => {
    const socket = netConnect(port, host, () => resolve(socket));
    socket.once('error', reject);
  });
}

function write(socket: NetSocket, data: string): Promise<void> {
  return new Promise((resolve, reject) => {
    socket.write(data, (error) => {
      if (error) reject(error);
      else resolve();
    });
  });
}

/** Frames `line` per RFC 6587 octet-counting: `<byte length> <line>`. */
function octetCounted(line: string): string {
  return `${Buffer.byteLength(line, 'utf8')} ${line}`;
}

function waitForClose(socket: NetSocket): Promise<void> {
  return new Promise((resolve) => {
    if (socket.destroyed) {
      resolve();
      return;
    }
    socket.once('close', () => resolve());
  });
}

async function tick(times = 20): Promise<void> {
  for (let i = 0; i < times; i++) await new Promise<void>((resolve) => setImmediate(resolve));
}

// ---------------------------------------------------------------------------------------------
// UDP client helper
// ---------------------------------------------------------------------------------------------

function sendUdp(client: DgramSocket, port: number, host: string, text: string): Promise<void> {
  return new Promise((resolve, reject) => {
    client.send(Buffer.from(text, 'utf8'), port, host, (error) => {
      if (error) reject(error);
      else resolve();
    });
  });
}

describe('syslog: tcp happy path', () => {
  it('decodes an RFC 5424 message framed with octet-counting', async () => {
    const { harness, handle } = await startTracked({ tcp: { address: '127.0.0.1:0' } }, false);
    const addr = handle.tcpAddress()!;
    const socket = await tcpConnect(addr.port);
    await write(socket, octetCounted(RFC5424_MSG));
    await waitUntil(() => harness.sent.length === 1);
    const events = harness.sent[0]!.events.filter(isLogEvent);
    expect(events).toHaveLength(1);
    const event = events[0]!;
    expect(event.get('hostname')).toBe('mymachine.example.com');
    expect(event.get('app_name')).toBe('su');
    expect(event.get('proc_id')).toBe('1234');
    expect(event.get('msg_id')).toBe('ID47');
    expect(event.get('message')).toBe('Hello world');
    expect(event.get('severity')).toBe(2n);
    expect(event.get('facility')).toBe(4n);
    expect(event.get('syslog.peer_addr')).toBe('127.0.0.1');
    expect(typeof event.get('syslog.peer_port')).toBe('bigint');
    socket.destroy();
  });

  it('decodes an RFC 3164 message framed with the newline fallback', async () => {
    const { harness, handle } = await startTracked({ tcp: { address: '127.0.0.1:0' } }, false);
    const addr = handle.tcpAddress()!;
    const socket = await tcpConnect(addr.port);
    await write(socket, `${RFC3164_MSG}\n`);
    await waitUntil(() => harness.sent.length === 1);
    const events = harness.sent[0]!.events.filter(isLogEvent);
    expect(events).toHaveLength(1);
    const event = events[0]!;
    expect(event.get('hostname')).toBe('mymachine');
    expect(event.get('app_name')).toBe('su');
    expect(event.get('message')).toBe("'su root' failed for lonvick on /dev/pts/8");
    expect(event.get('severity')).toBe(2n);
    expect(event.get('facility')).toBe(4n);
    socket.destroy();
  });

  it('accepts several octet-counted messages on the same connection', async () => {
    const { harness, handle } = await startTracked({ tcp: { address: '127.0.0.1:0' } }, false);
    const addr = handle.tcpAddress()!;
    const socket = await tcpConnect(addr.port);
    await write(socket, octetCounted(RFC5424_MSG) + octetCounted(RFC5424_MSG));
    await waitUntil(() => harness.sent.reduce((n, b) => n + b.events.length, 0) === 2);
    socket.destroy();
  });
});

describe('syslog: tcp decoding errors and limits', () => {
  it('discards a malformed line without killing the connection', async () => {
    const { harness, handle } = await startTracked({ tcp: { address: '127.0.0.1:0' } }, false);
    const addr = handle.tcpAddress()!;
    const socket = await tcpConnect(addr.port);
    await write(socket, `${MALFORMED_5424_SHAPED}\n`);
    await write(socket, `${RFC3164_MSG}\n`);
    await waitUntil(() => harness.sent.length === 1);
    const events = harness.sent[0]!.events.filter(isLogEvent);
    expect(events).toHaveLength(1);
    expect(events[0]!.get('hostname')).toBe('mymachine');
    expect(socket.destroyed).toBe(false);
    socket.destroy();
  });

  it('closes the connection when a newline-framed line exceeds max_frame_length, without crashing the source', async () => {
    const { harness, handle } = await startTracked(
      { tcp: { address: '127.0.0.1:0', max_frame_length: 128 } },
      false,
    );
    const addr = handle.tcpAddress()!;
    const bad = await tcpConnect(addr.port);
    await write(bad, `${'x'.repeat(300)}\n`);
    await waitForClose(bad);

    const good = await tcpConnect(addr.port);
    await write(good, `${RFC3164_MSG}\n`);
    await waitUntil(() => harness.sent.length === 1);
    good.destroy();
  });

  it('closes the connection when an octet-counted length exceeds max_frame_length', async () => {
    const { handle } = await startTracked(
      { tcp: { address: '127.0.0.1:0', max_frame_length: 8 } },
      false,
    );
    const addr = handle.tcpAddress()!;
    const socket = await tcpConnect(addr.port);
    await write(socket, `100 ${'x'.repeat(50)}`);
    await waitForClose(socket);
  });

  it('rejects a connection over max_connections', async () => {
    const { handle } = await startTracked(
      { tcp: { address: '127.0.0.1:0', max_connections: 1 } },
      false,
    );
    const addr = handle.tcpAddress()!;
    const first = await tcpConnect(addr.port);
    await tick();

    const second = await new Promise<NetSocket>((resolve) => {
      const socket = netConnect(addr.port, '127.0.0.1');
      socket.once('connect', () => resolve(socket));
      socket.once('error', () => resolve(socket));
    });
    await waitForClose(second);
    first.destroy();
  });
});

describe('syslog: tcp TLS', () => {
  it('decodes a syslog message received over a real TLS handshake', async () => {
    const { certPem, keyPem } = generateSelfSignedCert('127.0.0.1');
    const fs = await import('node:fs/promises');
    const certFile = join(tmpdir(), `ferrule-syslog-test-cert-${process.pid}.pem`);
    const keyFile = join(tmpdir(), `ferrule-syslog-test-key-${process.pid}.pem`);
    await fs.writeFile(certFile, certPem);
    await fs.writeFile(keyFile, keyPem);
    try {
      const { harness, handle } = await startTracked(
        { tcp: { address: '127.0.0.1:0', tls: { cert_file: certFile, key_file: keyFile } } },
        false,
      );
      const addr = handle.tcpAddress()!;

      const socket = await new Promise<TLSSocket>((resolve, reject) => {
        const s = tlsConnect(
          { host: '127.0.0.1', port: addr.port, ca: certPem, checkServerIdentity: () => undefined },
          () => resolve(s),
        );
        s.once('error', reject);
      });
      expect(socket.authorized).toBe(true);
      await write(socket, `${RFC3164_MSG}\n`);
      await waitUntil(() => harness.sent.length === 1);
      const events = harness.sent[0]!.events.filter(isLogEvent);
      expect(events[0]!.get('hostname')).toBe('mymachine');
      socket.end();
    } finally {
      await fs.rm(certFile, { force: true });
      await fs.rm(keyFile, { force: true });
    }
  });
});

describe('syslog: tcp backpressure and acknowledgement outcomes', () => {
  it('stops reading the connection while output.send is pending, and resumes once it resolves', async () => {
    const parsed = syslogSource.options.parse({ tcp: { address: '127.0.0.1:0' } });
    const handle = (await syslogSource.build(parsed, buildCtx())) as SyslogSourceHandle;
    const harness = createControllableSourceContext({ acknowledgements: false });
    harness.blockSends();
    const runPromise = handle.run(harness.ctx);
    runningServers.push({
      stop: async () => {
        harness.releaseSends();
        harness.abort();
        await runPromise;
      },
    });
    await waitUntil(() => handle.tcpAddress() !== undefined);
    const addr = handle.tcpAddress()!;
    const socket = await tcpConnect(addr.port);

    await write(socket, `${RFC3164_MSG}\n`);
    await waitUntil(() => harness.sent.length === 1);

    await write(socket, `${RFC3164_MSG}\n`);
    await tick();
    expect(harness.sent.length).toBe(1); // second message not yet read: the socket is paused

    harness.releaseSends();
    await waitUntil(() => harness.sent.length === 2);
    socket.destroy();
  });

  it('awaits acknowledgement before resuming the connection, on a delivered outcome', async () => {
    const { harness, handle } = await startTracked({ tcp: { address: '127.0.0.1:0' } });
    const addr = handle.tcpAddress()!;
    const socket = await tcpConnect(addr.port);

    await write(socket, `${RFC3164_MSG}\n`);
    await waitUntil(() => harness.sent.length === 1);

    await write(socket, `${RFC3164_MSG}\n`);
    await tick();
    expect(harness.sent.length).toBe(1); // still waiting on the first batch's acknowledgement

    for (const event of harness.sent[0]!.events) event.metadata.finalizers.finish('delivered');
    await waitUntil(() => harness.sent.length === 2);
    socket.destroy();
  });

  it('logs a warning when a tcp batch is acknowledged as errored', async () => {
    const { harness, handle } = await startTracked({ tcp: { address: '127.0.0.1:0' } });
    const addr = handle.tcpAddress()!;
    const socket = await tcpConnect(addr.port);
    await write(socket, `${RFC3164_MSG}\n`);
    await waitUntil(() => harness.sent.length === 1);
    for (const event of harness.sent[0]!.events) event.metadata.finalizers.finish('errored');
    await waitUntil(() =>
      harness.logs.some((log) => log.level === 'warn' && log.fields['status'] === 'errored'),
    );
    socket.destroy();
  });

  it('logs a warning when a tcp batch is acknowledged as rejected', async () => {
    const { harness, handle } = await startTracked({ tcp: { address: '127.0.0.1:0' } });
    const addr = handle.tcpAddress()!;
    const socket = await tcpConnect(addr.port);
    await write(socket, `${RFC3164_MSG}\n`);
    await waitUntil(() => harness.sent.length === 1);
    for (const event of harness.sent[0]!.events) event.metadata.finalizers.finish('rejected');
    await waitUntil(() =>
      harness.logs.some((log) => log.level === 'warn' && log.fields['status'] === 'rejected'),
    );
    socket.destroy();
  });
});

describe('syslog: tcp graceful shutdown', () => {
  it('finishes an in-flight message before run() resolves, and stops accepting new connections', async () => {
    const parsed = syslogSource.options.parse({ tcp: { address: '127.0.0.1:0' } });
    const handle = (await syslogSource.build(parsed, buildCtx())) as SyslogSourceHandle;
    const harness = createControllableSourceContext();
    harness.blockSends();
    const runPromise = handle.run(harness.ctx);
    await waitUntil(() => handle.tcpAddress() !== undefined);
    const addr = handle.tcpAddress()!;
    const socket = await tcpConnect(addr.port);
    await write(socket, `${RFC3164_MSG}\n`);
    await waitUntil(() => harness.sent.length === 1);

    harness.abort();
    let resolved = false;
    void runPromise.then(() => {
      resolved = true;
    });
    await new Promise((resolve) => setTimeout(resolve, 50));
    expect(resolved).toBe(false); // still waiting on the in-flight message

    // a new connection attempt is refused now that the listener has closed
    const rejected = await new Promise<boolean>((resolve) => {
      const other = netConnect(addr.port, '127.0.0.1');
      other.once('connect', () => resolve(false));
      other.once('error', () => resolve(true));
    });
    expect(rejected).toBe(true);

    harness.releaseSends();
    for (const event of harness.sent[0]!.events) event.metadata.finalizers.finish('delivered');
    await runPromise;
    expect(resolved).toBe(true);
    socket.destroy();
  });
});

describe('syslog: format pinning', () => {
  it('format "rfc5424" decodes a 5424 message and discards a 3164-shaped one', async () => {
    const { harness, handle } = await startTracked(
      { tcp: { address: '127.0.0.1:0' }, format: 'rfc5424' },
      false,
    );
    const addr = handle.tcpAddress()!;
    const socket = await tcpConnect(addr.port);
    await write(socket, `${RFC3164_MSG}\n`);
    await write(socket, `${RFC5424_MSG}\n`);
    await waitUntil(() => harness.sent.length === 1);
    const events = harness.sent[0]!.events.filter(isLogEvent);
    expect(events).toHaveLength(1);
    expect(events[0]!.get('hostname')).toBe('mymachine.example.com');
    socket.destroy();
  });

  it('format "rfc3164" decodes a 3164 message and discards a 5424-shaped one', async () => {
    const { harness, handle } = await startTracked(
      { tcp: { address: '127.0.0.1:0' }, format: 'rfc3164' },
      false,
    );
    const addr = handle.tcpAddress()!;
    const socket = await tcpConnect(addr.port);
    await write(socket, `${RFC5424_MSG}\n`);
    await write(socket, `${RFC3164_MSG}\n`);
    await waitUntil(() => harness.sent.length === 1);
    const events = harness.sent[0]!.events.filter(isLogEvent);
    expect(events).toHaveLength(1);
    expect(events[0]!.get('hostname')).toBe('mymachine');
    socket.destroy();
  });
});

describe('syslog: udp', () => {
  it('decodes RFC 5424 and RFC 3164 datagrams', async () => {
    const { harness, handle } = await startTracked({ udp: { address: '127.0.0.1:0' } }, false);
    const addr = handle.udpAddress()!;
    const client = createDgramSocket('udp4');
    try {
      await sendUdp(client, addr.port, addr.host, RFC5424_MSG);
      await waitUntil(() => harness.sent.length === 1);
      await sendUdp(client, addr.port, addr.host, RFC3164_MSG);
      await waitUntil(() => harness.sent.length === 2);

      const events = harness.sent.flatMap((b) => b.events).filter(isLogEvent);
      expect(events[0]!.get('hostname')).toBe('mymachine.example.com');
      expect(events[0]!.get('syslog.peer_addr')).toBe('127.0.0.1');
      expect(typeof events[0]!.get('syslog.peer_port')).toBe('bigint');
      expect(events[1]!.get('hostname')).toBe('mymachine');
    } finally {
      client.close();
    }
  });

  it('drops a malformed datagram without crashing, and still decodes a subsequent good one', async () => {
    const { harness, handle } = await startTracked({ udp: { address: '127.0.0.1:0' } }, false);
    const addr = handle.udpAddress()!;
    const client = createDgramSocket('udp4');
    try {
      await sendUdp(client, addr.port, addr.host, MALFORMED_5424_SHAPED);
      await sendUdp(client, addr.port, addr.host, RFC3164_MSG);
      await waitUntil(() => harness.sent.length === 1);
      const events = harness.sent[0]!.events.filter(isLogEvent);
      expect(events[0]!.get('hostname')).toBe('mymachine');
    } finally {
      client.close();
    }
  });

  it('drops an oversize datagram and counts it, without crashing the source', async () => {
    const { harness, handle } = await startTracked(
      { udp: { address: '127.0.0.1:0', max_packet_size: 128 } },
      false,
    );
    const addr = handle.udpAddress()!;
    const client = createDgramSocket('udp4');
    try {
      await sendUdp(client, addr.port, addr.host, 'x'.repeat(300));
      await sendUdp(client, addr.port, addr.host, RFC3164_MSG);
      await waitUntil(() => harness.sent.length === 1);
      const events = harness.sent[0]!.events.filter(isLogEvent);
      expect(events[0]!.get('hostname')).toBe('mymachine');
    } finally {
      client.close();
    }
  });
});

describe('syslog: validation', () => {
  it('fails to build when neither tcp nor udp is configured', () => {
    expect(() => syslogSource.options.parse({})).toThrow(/tcp.*udp|udp.*tcp/i);
  });

  it('fails to build with an empty tcp/udp configuration object omitted entirely', () => {
    expect(() => syslogSource.options.parse({ format: 'auto' })).toThrow();
  });
});
