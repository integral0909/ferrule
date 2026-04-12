import { withGlobalFlags } from '../args.js';
import type { Command } from '../command.js';
import {
  configPathsFromFlags,
  isConfigError,
  loadCliConfig,
  renderConfigLoadError,
  renderTopologyIssuesText,
  secretBackendFromFlags,
  toCliTopologySpec,
  topologyOverridesFromFlags,
} from '../config-support.js';
import { EXIT_CONFIG_ERROR, EXIT_OK } from '../exit-codes.js';
import { buildDefaultRegistry } from '../registry.js';
import { writeLine } from '../output.js';
import { buildTopology, type TopologySpec } from '@ferrule/runtime';
import type { LoadedConfig } from '@ferrule/config';

function withoutDataDir(spec: TopologySpec): TopologySpec {
  if (spec.settings?.dataDir === undefined) return spec;
  const { dataDir: _dataDir, ...rest } = spec.settings;
  return { ...spec, settings: rest };
}

export const validateCommand: Command = {
  spec: withGlobalFlags({
    name: 'validate',
    summary: 'Validate a pipeline config without starting it.',
    usage: 'ferrule validate -c <file|dir>... [options]',
    flags: [
      {
        name: 'config',
        short: 'c',
        type: 'path',
        description: 'A config file or directory.',
        repeatable: true,
      },
      {
        name: 'data-dir',
        type: 'path',
        description: 'Overrides data_dir from the config (ignored with --no-environment).',
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
      {
        name: 'environment',
        type: 'boolean',
        negatable: true,
        description:
          'Run checks that touch the environment (creating data directories). Default true.',
        default: true,
      },
      { name: 'json', type: 'boolean', description: 'Print diagnostics as machine-readable JSON.' },
    ],
    examples: ['ferrule validate -c pipeline.yaml', 'ferrule validate -c conf.d --no-environment'],
  }),

  async run(ctx, args) {
    const registry = buildDefaultRegistry();
    const paths = configPathsFromFlags(args, ctx.env.cwd);
    const secretBackend = secretBackendFromFlags(args);
    const skipEnvironment = args.flags.get('environment') === false;
    const asJson = args.flags.get('json') === true;

    let config: LoadedConfig;
    try {
      config = await loadCliConfig(paths, {
        registry,
        env: ctx.env.env,
        ...(secretBackend !== undefined ? { secretBackend } : {}),
      });
    } catch (error) {
      if (isConfigError(error)) {
        if (asJson) {
          writeLine(ctx.env.stdout, JSON.stringify(error.diagnostics, null, 2));
        } else {
          writeLine(ctx.env.stderr, renderConfigLoadError(error, ctx.color));
        }
        return EXIT_CONFIG_ERROR;
      }
      throw error;
    }

    let spec = toCliTopologySpec(config, topologyOverridesFromFlags(args, ctx.env.cwd));
    if (skipEnvironment) spec = withoutDataDir(spec);
    const result = await buildTopology(spec, registry);

    if (!result.ok) {
      if (asJson) {
        writeLine(
          ctx.env.stdout,
          JSON.stringify({ errors: result.errors, warnings: result.warnings }, null, 2),
        );
      } else {
        writeLine(ctx.env.stderr, await renderTopologyIssuesText(result.errors, config, ctx.color));
        if (result.warnings.length > 0) {
          writeLine(ctx.env.stderr, '');
          writeLine(
            ctx.env.stderr,
            await renderTopologyIssuesText(result.warnings, config, ctx.color),
          );
        }
      }
      return EXIT_CONFIG_ERROR;
    }

    if (asJson) {
      writeLine(
        ctx.env.stdout,
        JSON.stringify(
          {
            ok: true,
            warnings: result.warnings,
            components: [...result.topology.components.keys()],
          },
          null,
          2,
        ),
      );
    } else {
      if (result.warnings.length > 0) {
        writeLine(
          ctx.env.stdout,
          await renderTopologyIssuesText(result.warnings, config, ctx.color),
        );
      }
      writeLine(
        ctx.env.stdout,
        `valid: ${result.topology.components.size} component(s), 0 error(s), ${result.warnings.length} warning(s)`,
      );
    }
    return EXIT_OK;
  },
};
