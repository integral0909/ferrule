#!/usr/bin/env node
import { runCli } from './cli.js';
import { createNodeEnvironment } from './environment.js';

const exitCode = await runCli(createNodeEnvironment());
process.exitCode = exitCode;
