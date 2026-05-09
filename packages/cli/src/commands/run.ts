import { createAdminServer, type AdminServer } from '@ferrule/admin';
import { diffConfigs, type LoadedConfig } from '@ferrule/config';
import { stat } from 'node:fs/promises';
import {
  createDiskBufferFactory,
  createLogger,
  MetricsRegistry,
  Pipeline,
  TopologyValidationError,
  type Logger,
  type LogLevel,
  type ReloadResult,
  type TopologyIssue,
} from '@ferrule/runtime';
import { flagString, withGlobalFlags } from '../args.js';
import type { Command, CliContext } from '../command.js';
import {
  configPathsFromFlags,
  expandConfigPathsForWatch,
  isConfigError,
  loadCliConfig,
  renderConfigLoadError,
  renderTopologyIssuesText,
  secretBackendFromFlags,
  toCliTopologySpec,
  topologyOverridesFromFlags,
} from '../config-support.js';
import { EXIT_CONFIG_ERROR, EXIT_OK, EXIT_RUNTIME_FAILURE } from '../exit-codes.js';
import { buildDefaultRegistry } from '../registry.js';
import { writeLine } from '../output.js';
import type { ParsedArgs } from '../args.js';

const LOG_LEVELS = ['trace', 'debug', 'info', 'warn', 'error'] as const;
const LOG_FORMATS = ['text', 'json'] as const;

type CliLogLevel = (typeof LOG_LEVELS)[number];

function resolveLogLevel(args: ParsedArgs, config: LoadedConfig): LogLevel {
  const flag = args.flags.get('log-level');
  const chosen: CliLogLevel = typeof flag === 'string' ? (flag as CliLogLevel) : config.log.level;
  // The runtime logger has no separate `trace` level; it is treated as `debug`.
  return chosen === 'trace' ? 'debug' : chosen;
}

function resolveLogFormat(args: ParsedArgs, config: LoadedConfig): 'json' | 'pretty' {
  const flag = args.flags.get('log-format');
  const chosen = typeof flag === 'string' ? flag : config.log.format;
  return chosen === 'json' ? 'json' : 'pretty';
}

function parseAddress(text: string): { host: string; port: number } | undefined {
  const m = /^(.+):(\d+)$/.exec(text);
  if (m === null) return undefined;
  return { host: m[1]!, port: Number(m[2]) };
}

function configLoadFailureAsIssues(
  diagnostics: readonly { code: string; message: string; file: string }[],
): TopologyIssue[] {
  return diagnostics.map((d) => ({
    severity: 'error',
    code: d.code,
    message: `${d.file}: ${d.message}`,
  }));
}

export const runCommand: Command = {
  spec: withGlobalFlags({
    name: 'run',
    summary: 'Run a pipeline.',
    usage: 'ferrule run -c <file|dir>... [options]',
    flags: [
      {
        name: 'config',
        short: 'c',
        type: 'path',
        description: 'A config file or directory.',
        repeatable: true,
      },
      {
        name: 'secrets-dir',
        type: 'path',
        description: 'Resolve ${secret:NAME} from files in this directory.',
      },
      {
        name: 'secrets-env-prefix',
        type: 'string',
        description: 'Resolve ${secret:NAME} from env vars under this prefix.',
      },
      { name: 'data-dir', type: 'path', description: 'Overrides data_dir from the config.' },
      {
        name: 'healthchecks',
        type: 'boolean',
        negatable: true,
        default: true,
        description: 'Run sink health checks at startup.',
      },
      {
        name: 'shutdown-timeout',
        type: 'duration',
        description: 'Graceful shutdown deadline. Overrides the config.',
      },
      {
        name: 'log-level',
        type: 'enum',
        enumValues: LOG_LEVELS,
        description: 'Overrides log.level from the config.',
      },
      {
        name: 'log-format',
        type: 'enum',
        enumValues: LOG_FORMATS,
        description: 'Overrides log.format from the config.',
      },
      {
        name: 'api',
        type: 'boolean',
        description: 'Start the admin API even if the config disables it.',
      },
      {
        name: 'api-address',
        type: 'string',
        description: 'Admin API listen address (host:port). Overrides the config.',
      },
      {
        name: 'api-token',
        type: 'string',
        description: 'Admin API bearer token. Defaults to $FERRULE_API_TOKEN.',
      },
      {
        name: 'watch',
        type: 'boolean',
        description: 'Reload automatically when a config file changes.',
      },
    ],
    examples: ['ferrule run -c pipeline.yaml', 'ferrule run -c conf.d --watch --api'],
  }),

  async run(ctx, args) {
    const registry = buildDefaultRegistry();
    const paths = configPathsFromFlags(args, ctx.env.cwd);
    const secretBackend = secretBackendFromFlags(args, ctx.env.env);
    const overrides = topologyOverridesFromFlags(args, ctx.env.cwd);

    let config: LoadedConfig;
    try {
      config = await loadCliConfig(paths, {
        registry,
        env: ctx.env.env,
        ...(secretBackend !== undefined ? { secretBackend } : {}),
      });
    } catch (error) {
      if (isConfigError(error)) {
        writeLine(ctx.env.stderr, renderConfigLoadError(error, ctx.color));
        return EXIT_CONFIG_ERROR;
      }
      throw error;
    }

    const logger: Logger = createLogger({
      level: resolveLogLevel(args, config),
      format: resolveLogFormat(args, config),
      sink: { write: (chunk) => ctx.env.stderr.write(chunk) },
      clock: ctx.env.clock,
    });
    const metrics = new MetricsRegistry({ clock: ctx.env.clock });
    const bufferFactory = createDiskBufferFactory();

    let pipeline: Pipeline;
    try {
      pipeline = await Pipeline.create(toCliTopologySpec(config, overrides), {
        registry,
        logger,
        clock: ctx.env.clock,
        metrics,
        bufferFactory,
      });
    } catch (error) {
      if (error instanceof TopologyValidationError) {
        writeLine(ctx.env.stderr, await renderTopologyIssuesText(error.issues, config, ctx.color));
        return EXIT_CONFIG_ERROR;
      }
      throw error;
    }

    await pipeline.start();
    logger.info('pipeline started', { components: pipeline.snapshot().components.length });

    let currentConfig = config;

    const performReload = async (): Promise<ReloadResult> => {
      let nextConfig: LoadedConfig;
      try {
        nextConfig = await loadCliConfig(paths, {
          registry,
          env: ctx.env.env,
          ...(secretBackend !== undefined ? { secretBackend } : {}),
        });
      } catch (error) {
        if (isConfigError(error)) {
          logger.error('reload failed: invalid config', { issues: error.diagnostics.length });
          return { ok: false, errors: configLoadFailureAsIssues(error.diagnostics) };
        }
        throw error;
      }
      const diff = diffConfigs(currentConfig, nextConfig);
      const result = await pipeline.reload(toCliTopologySpec(nextConfig, overrides));
      if (result.ok) {
        currentConfig = nextConfig;
        logger.info('reload succeeded', {
          added: diff.added,
          removed: diff.removed,
          changed: diff.changed,
          unchanged: diff.unchanged.length,
        });
      } else {
        logger.error('reload failed: invalid topology; keeping the running pipeline', {
          errors: result.errors.map((e) => e.message),
        });
      }
      return result;
    };

    let admin: AdminServer | undefined;
    const apiEnabled = args.flags.get('api') === true || config.api.enabled;
    if (apiEnabled) {
      const addressFlag = flagString(args, 'api-address');
      const address = addressFlag !== undefined ? parseAddress(addressFlag) : config.api.address;
      const token = flagString(args, 'api-token') ?? ctx.env.env['FERRULE_API_TOKEN'];
      admin = createAdminServer({
        pipeline,
        metrics,
        ...(address !== undefined ? { address } : {}),
        ...(token !== undefined ? { auth: { token } } : {}),
        onReload: performReload,
        configDump: () => currentConfig.redactedDump(),
        logger,
        clock: ctx.env.clock,
      });
      const bound = await admin.start();
      logger.info('admin API listening', { host: bound.host, port: bound.port });
    }

    const exitCode = await waitForShutdown(ctx, logger, pipeline, performReload, paths, args);

    if (admin !== undefined) await admin.stop();
    return exitCode;
  },
};

async function waitForShutdown(
  ctx: CliContext,
  logger: Logger,
  pipeline: Pipeline,
  performReload: () => Promise<ReloadResult>,
  paths: readonly string[],
  args: ParsedArgs,
): Promise<number> {
  let stopping = false;
  let forced = false;
  let exitCode = EXIT_OK;
  let stopPromise: Promise<void> = Promise.resolve();
  let resolveStopRequested!: () => void;
  const stopRequested = new Promise<void>((resolve) => {
    resolveStopRequested = resolve;
  });

  const beginStop = (reason: string): void => {
    if (stopping) return;
    stopping = true;
    logger.info(reason);
    stopPromise = pipeline.stop();
    resolveStopRequested();
  };

  const handleTermSignal = (name: string): void => {
    if (stopping) {
      logger.warn(`received a second ${name}; forcing exit without waiting for graceful shutdown`);
      forced = true;
      exitCode = EXIT_RUNTIME_FAILURE;
      resolveStopRequested();
      ctx.env.hardExit(1);
      return;
    }
    beginStop(`received ${name}; shutting down gracefully`);
  };

  const unsubs = [
    ctx.env.signals.on('SIGINT', () => handleTermSignal('SIGINT')),
    ctx.env.signals.on('SIGTERM', () => handleTermSignal('SIGTERM')),
    ctx.env.signals.on('SIGHUP', () => {
      logger.info('received SIGHUP; reloading configuration');
      void performReload();
    }),
  ];

  const watch = args.flags.get('watch') === true;
  const watchLoop = watch
    ? runWatchLoop(ctx, logger, paths, performReload, () => stopping)
    : undefined;

  const failureWatch = (async (): Promise<void> => {
    while (!stopping) {
      const health = pipeline.health();
      if (health.overall === 'failed') {
        exitCode = EXIT_RUNTIME_FAILURE;
        beginStop('pipeline reported a failed component; shutting down');
        return;
      }
      try {
        await ctx.env.clock.sleep(200);
      } catch {
        return;
      }
    }
  })();

  await stopRequested;
  if (!forced) await stopPromise;
  for (const unsub of unsubs) unsub();
  // `failureWatch` and `watchLoop` (when `--watch` is set) are left to wind themselves down in
  // the background: both poll on `ctx.env.clock.sleep(...)` and exit on their own once `stopping`
  // is observed, but neither should hold up returning the exit code once shutdown is underway.
  void failureWatch;
  void watchLoop;

  return exitCode;
}

async function runWatchLoop(
  ctx: CliContext,
  logger: Logger,
  paths: readonly string[],
  performReload: () => Promise<ReloadResult>,
  isStopping: () => boolean,
): Promise<void> {
  const files = await expandConfigPathsForWatch(paths);
  const mtimes = new Map<string, number>();
  for (const file of files) {
    mtimes.set(file, (await stat(file).catch(() => undefined))?.mtimeMs ?? 0);
  }
  while (!isStopping()) {
    try {
      await ctx.env.clock.sleep(500);
    } catch {
      return;
    }
    if (isStopping()) return;
    let changed = false;
    for (const file of files) {
      const mtime = (await stat(file).catch(() => undefined))?.mtimeMs;
      if (mtime !== undefined && mtime !== mtimes.get(file)) {
        mtimes.set(file, mtime);
        changed = true;
      }
    }
    if (!changed) continue;
    // Debounce rapid successive writes (e.g. an editor's save-then-rewrite) before reloading.
    try {
      await ctx.env.clock.sleep(200);
    } catch {
      return;
    }
    if (isStopping()) return;
    logger.info('config file changed; reloading');
    await performReload();
  }
}
