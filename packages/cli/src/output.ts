import type { CliReadable, CliWritable } from './environment.js';

export function writeLine(stream: CliWritable, text = ''): void {
  stream.write(`${text}\n`);
}

export function write(stream: CliWritable, text: string): void {
  stream.write(text);
}

/** Reads an entire stream to completion and returns it as a UTF-8 string. */
export async function readAll(stream: CliReadable): Promise<string> {
  const chunks: string[] = [];
  for await (const chunk of stream) {
    chunks.push(typeof chunk === 'string' ? chunk : chunk.toString('utf8'));
  }
  return chunks.join('');
}

/** Splits a stream into lines as they arrive, without waiting for the whole stream to end. */
export async function* readLines(stream: CliReadable): AsyncGenerator<string, void, void> {
  let buffer = '';
  for await (const chunk of stream) {
    buffer += typeof chunk === 'string' ? chunk : chunk.toString('utf8');
    let newline = buffer.indexOf('\n');
    while (newline !== -1) {
      let line = buffer.slice(0, newline);
      if (line.endsWith('\r')) line = line.slice(0, -1);
      yield line;
      buffer = buffer.slice(newline + 1);
      newline = buffer.indexOf('\n');
    }
  }
  if (buffer.length > 0) yield buffer;
}
