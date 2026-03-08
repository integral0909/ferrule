#!/usr/bin/env node
import { startLanguageServer } from './server.js';

const server = startLanguageServer({
  input: process.stdin,
  output: process.stdout,
  onExit: (code) => process.exit(code),
});

// Keep stdin flowing even before the client sends anything, and make sure the process doesn't
// exit early because nothing else is holding the event loop open.
process.stdin.resume();

process.on('SIGTERM', () => server.dispose());
process.on('SIGINT', () => server.dispose());
